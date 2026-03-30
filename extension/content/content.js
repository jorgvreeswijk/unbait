// Prevent double-injection — wrap everything in this guard
if (window.__unbaitLoaded) {
  // Already loaded, skip
} else {
window.__unbaitLoaded = true;

let _isProcessing = false;
let _rewriteResolve = null;

// Store original/new titles keyed by URL — survives React re-renders
const _unbaitTitles = new Map();

// Gist summary state
let _gistEnabled = true;
let _gistClickMode = "summary"; // "summary" = single click shows gist, "title" = single click toggles title
let _gistActiveOverlay = null;
let _gistActiveUrl = null;
let _gistActiveIconEl = null;
let _gistPendingRequests = new Set();
let _gistCacheWriteQueue = Promise.resolve();

chrome.storage.local.get(["gistEnabled", "gistClickMode"], (data) => {
  _gistEnabled = data.gistEnabled !== false;
  _gistClickMode = data.gistClickMode || "summary";
});

// Event delegation for icon clicks — survives DOM replacement
// When gist is enabled: single click = gist overlay, double click = toggle title
// When gist is disabled: click = toggle title (current behavior)
let _clickTimer = null;
let _clickTarget = null;

document.addEventListener("click", (e) => {
  // Handle G-icon clicks (gist-only headlines without de-clickbaited title)
  const gIcon = e.target.closest(".gist-icon");
  if (gIcon) {
    e.preventDefault();
    e.stopPropagation();
    handleGistClickFromGIcon(gIcon);
    return;
  }

  const icon = e.target.closest(".unbait-icon");
  if (!icon) return;
  e.preventDefault();
  e.stopPropagation();

  if (!_gistEnabled) {
    // Gist off: immediate toggle (current behavior)
    const el = icon.closest(".unbait-replaced");
    if (el) toggleTitle(el, icon);
    return;
  }

  // Gist on: single/double click discrimination
  if (_clickTimer && _clickTarget === icon) {
    // Second click within 250ms → double click
    clearTimeout(_clickTimer);
    _clickTimer = null;
    _clickTarget = null;
    const el = icon.closest(".unbait-replaced");
    if (el) {
      if (_gistClickMode === "title") handleGistClick(el, icon);
      else toggleTitle(el, icon);
    }
  } else {
    // First click → wait 250ms for potential second click
    _clickTarget = icon;
    _clickTimer = setTimeout(() => {
      _clickTimer = null;
      _clickTarget = null;
      // Single click
      const el = icon.closest(".unbait-replaced");
      if (el) {
        if (_gistClickMode === "title") toggleTitle(el, icon);
        else handleGistClick(el, icon);
      }
    }, 250);
  }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const icon = e.target.closest(".unbait-icon");
  if (!icon) return;
  e.preventDefault();
  const el = icon.closest(".unbait-replaced");
  if (el) toggleTitle(el, icon);
}, true);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "de-clickbait") {
    if (_isProcessing) {
      sendResponse({ error: "Already processing, please wait." });
      return true;
    }
    _isProcessing = true;
    processHeadlines().then((result) => {
      _isProcessing = false;
      sendResponse(result);
    }).catch((err) => {
      _isProcessing = false;
      sendResponse({ error: err.message });
    });
    return true; // async response
  }
  if (message.action === "stream-result") {
    applyStreamResult(message.result);
  }
  if (message.action === "rewrite-complete") {
    // Final results from service worker (Safari-compatible path)
    _isProcessing = false;
    const result = message.result;
    if (result && result.results) {
      for (const r of result.results) {
        applyResult(r);
      }
    }
    // Resolve the pending promise if any
    if (_rewriteResolve) {
      const found = message.found || 0;
      _rewriteResolve({ success: true, found, count: _unbaitApplied.size });
      _rewriteResolve = null;
    }
  }
  if (message.action === "gist-stream") {
    handleGistStream(message);
  }
  if (message.action === "gist-result") {
    handleGistResult(message);
  }
  if (message.action === "get-stats") {
    const replaced = document.querySelectorAll(".unbait-replaced").length;
    const icons = document.querySelectorAll(".unbait-icon").length;
    sendResponse({ found: (replaced + icons) > 0 ? _unbaitElements.size || replaced : 0, count: replaced });
  }
});

// Restore cached titles after back/forward navigation
// MutationObserver: detect when React/frameworks replace our modified elements
// and re-apply titles from the _unbaitTitles Map
const _unbaitObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    // Check removed nodes — if a replaced headline was removed, the framework
    // likely replaced it with a fresh node. Find the new node by URL and re-apply.
    for (const removed of mutation.removedNodes) {
      if (!(removed instanceof HTMLElement)) continue;
      const replaced = removed.classList?.contains("unbait-replaced")
        ? [removed]
        : Array.from(removed.querySelectorAll?.(".unbait-replaced") || []);
      for (const oldEl of replaced) {
        const url = oldEl.dataset.unbaitUrl;
        const stored = url && _unbaitTitles.get(url);
        if (!stored) continue;
        // Find the new element by matching URL in the current DOM
        requestAnimationFrame(() => {
          const links = document.querySelectorAll(`a[href="${CSS.escape(url)}"], a[href*="${CSS.escape(new URL(url).pathname)}"]`);
          for (const link of links) {
            const heading = link.querySelector("h1,h2,h3,h4,h5") || link.closest("h1,h2,h3,h4,h5") || link;
            if (heading && !heading.classList.contains("unbait-replaced")) {
              renderReplacedHeadline(heading, stored.rewritten, stored.original);
              break;
            }
          }
        });
      }
    }
  }
});
_unbaitObserver.observe(document.body, { childList: true, subtree: true });

// Multiple strategies because Safari is inconsistent about which events fire:

// Strategy 1: pageshow with persisted (standard bfcache)
window.addEventListener("pageshow", (event) => {
  if (event.persisted) restoreCachedTitles();
});

// Strategy 2: popstate (fires on back/forward in most browsers)
window.addEventListener("popstate", () => {
  if (!_isProcessing) restoreCachedTitles();
});

// Strategy 3: visibilitychange (fallback for Safari back-navigation)
// Only restore when there are NO replaced elements — icons on news sites are
// stable once placed and do not need re-adding on every focus switch.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !_isProcessing) {
    const hasUnbaitElements = document.querySelector(".unbait-replaced");
    if (!hasUnbaitElements) {
      restoreCachedTitles();
    }
  }
});

// Auto-restore cached titles on page load (for back navigation without bfcache)
// Only if not about to receive a de-clickbait message (small delay to let popup send first)
setTimeout(() => {
  if (!_isProcessing) restoreCachedTitles();
}, 200);

/**
 * Auto-restore cached titles on page load.
 * Scans all headlines on the page and applies cached titles if found.
 * This runs automatically when the content script loads, so previously
 * de-clickbaited pages show their improved titles after back-navigation.
 */
let _isRestoring = false;
async function restoreCachedTitles() {
  if (_isRestoring) return;
  _isRestoring = true;
  try {
    const headlines = findHeadlines();
    if (headlines.length === 0) { _isRestoring = false; return; }

    const provider = await getCurrentProvider();
    const cache = await getCache(provider);
    if (!cache || Object.keys(cache).length === 0) {
      injectGistIcons();
      return;
    }

    let restoredCount = 0;
    for (const item of headlines) {
      // Skip elements that are already replaced (bfcache restore)
      // Just restore their icons instead
      if (item.element.classList.contains("unbait-replaced") && item.element.dataset.unbaitOriginal) {
        restoreIconForElement(item.element);
        restoredCount++;
        continue;
      }

      const cached = cache[item.url];
      if (cached && cached.newTitle && Date.now() - cached.ts < CONFIG.CACHE_MAX_AGE_MS) {
        const originalText = cached.originalTitle || item.text;
        renderReplacedHeadline(item.element, cached.newTitle, originalText);
        restoredCount++;
      }
    }

    if (restoredCount > 0) {
      console.debug(`[Unbait] Restored ${restoredCount} cached titles`);
    }
    // Inject G-icons on headlines without U-icons
    injectGistIcons();
  } catch {
    // Silently fail — this is a best-effort restore
  } finally {
    _isRestoring = false;
  }
}

function restoreIconForElement(el) {
  // If a parent is also .unbait-replaced, let the parent handle icon placement
  // (guards against corrupted state where both <a> and inner <h2> are marked)
  if (el.parentElement?.closest(".unbait-replaced")) return;

  // Remove ALL existing icons — querySelectorAll catches duplicates from prior bugs
  el.querySelectorAll(".unbait-icon").forEach((n) => n.remove());

  if (el.dataset.unbaitNew) {
    const icon = document.createElement("span");
    icon.className = "unbait-icon";
    icon.title = "Click to show original";
    icon.setAttribute("role", "button");
    icon.setAttribute("tabindex", "0");
    icon.setAttribute("aria-label", "Toggle original headline");
    // Restore showing-original state
    if (el.textContent === el.dataset.unbaitOriginal) {
      icon.classList.add("showing-original");
    }
    // No inline listeners — handled by event delegation
    el.appendChild(icon);
  }
}

function restoreIcons() {
  document.querySelectorAll(".unbait-replaced").forEach(restoreIconForElement);
}

const CONFIG = {
  CACHE_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  CACHE_MAX_ENTRIES: 500,
  API_TIMEOUT_MS: 120000,
  MIN_HEADLINE_LENGTH: 15,
  MAX_HEADLINE_LENGTH: 300,
  MIN_LARGE_LINK_LENGTH: 30,
  MAX_LARGE_LINK_LENGTH: 200,
  MIN_FONT_SIZE_PX: 16,
  MIN_LINK_WIDTH_PX: 100,
  MIN_LINK_HEIGHT_PX: 20,
  MIN_PATH_LENGTH: 5,
  CONTEXT_CONCURRENCY: 10,
  CONTEXT_TIMEOUT_MS: 6000,
  CONTEXT_MAX_BYTES: 131072,
  CONTEXT_MAX_CHARS: 800,
  META_DESC_MAX_CHARS: 300,
  JSONLD_MAX_CHARS: 600,
  PARAGRAPH_MAX_CHARS: 800,
  MIN_PARAGRAPH_LENGTH: 40,
};

function _decodeEntities(str) {
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

function _extractMetaDesc(html) {
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
  const meta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  return (og?.[1] || meta?.[1] || "").substring(0, CONFIG.META_DESC_MAX_CHARS);
}

function _extractJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      let data = JSON.parse(m[1]);
      if (data["@graph"]) data = data["@graph"];
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const t = (item["@type"] || "").toLowerCase();
        if (t.includes("article") || t.includes("newsarticle") || t.includes("blogposting") || t.includes("reportage")) {
          const body = item.articleBody || "";
          const desc = item.description || "";
          const text = body.length > desc.length ? body : desc;
          if (text) return _decodeEntities(text).substring(0, CONFIG.JSONLD_MAX_CHARS);
        }
      }
    } catch { /* skip */ }
  }
  return "";
}

function _extractArticleContext(html) {
  const jsonLd = _extractJsonLd(html);
  const metaDesc = _extractMetaDesc(html);
  let bodyText = "";
  let cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "").replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");
  const artMatch = cleaned.match(/<(?:article|div)[^>]*(?:class|id)=["'][^"']*(?:article|story|post|entry|content)[-_]?(?:body|content|text|area)[^"']*["'][^>]*>([\s\S]*)/i)
    || cleaned.match(/<article[^>]*>([\s\S]*)/i);
  const region = artMatch ? artMatch[0] : cleaned;
  const paragraphs = [];
  let totalLen = 0;
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pm;
  while ((pm = pRe.exec(region)) !== null && totalLen < CONFIG.PARAGRAPH_MAX_CHARS) {
    const text = _decodeEntities(pm[1].replace(/<[^>]+>/g, ""));
    if (text.length < CONFIG.MIN_PARAGRAPH_LENGTH) continue;
    paragraphs.push(text);
    totalLen += text.length;
  }
  bodyText = paragraphs.join(" ");
  const best = jsonLd || bodyText || "";
  const extra = metaDesc && metaDesc !== best ? metaDesc : "";
  if (best && extra) return (best + " | " + extra).substring(0, CONFIG.CONTEXT_MAX_CHARS);
  return (best || extra || "").substring(0, CONFIG.CONTEXT_MAX_CHARS);
}

async function enrichHeadlinesWithContext(headlines) {
  const currentHost = window.location.hostname;
  const results = [];
  for (let i = 0; i < headlines.length; i += CONFIG.CONTEXT_CONCURRENCY) {
    const batch = headlines.slice(i, i + CONFIG.CONTEXT_CONCURRENCY);
    const promises = batch.map(async (h) => {
      try {
        const url = new URL(h.url);
        if (url.hostname !== currentHost) return h;
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), CONFIG.CONTEXT_TIMEOUT_MS);
        const resp = await fetch(h.url, { signal: controller.signal, credentials: "omit", referrer: "" });
        clearTimeout(tid);
        if (!resp.ok) return h;
        const ct = resp.headers.get("content-type") || "";
        if (!ct.includes("text/html")) return h;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let html = "";
        let bytes = 0;
        while (bytes < CONFIG.CONTEXT_MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          html += decoder.decode(value, { stream: true });
          bytes += value.length;
        }
        reader.cancel();
        return { ...h, context: _extractArticleContext(html) };
      } catch { return h; }
    });
    results.push(...(await Promise.all(promises)));
  }
  const withCtx = results.filter(h => h.context).length;
  console.debug("[Unbait] Context: " + withCtx + "/" + results.length + " from content script");
  return results;
}

// Global maps to track elements and applied results
const _unbaitElements = new Map();
const _unbaitApplied = new Set();

// Serialized cache write queue
let _cacheWriteQueue = Promise.resolve();

function cacheKeyForProvider(provider) {
  return `unbait_cache_${provider || "anthropic"}`;
}

async function getCurrentProvider() {
  const data = await chrome.storage.local.get("provider");
  return data.provider || "anthropic";
}

async function getCache(provider) {
  if (!provider) provider = await getCurrentProvider();
  const key = cacheKeyForProvider(provider);
  const data = await chrome.storage.local.get(key);
  return data[key] || {};
}

async function setCacheEntries(entries, provider) {
  _cacheWriteQueue = _cacheWriteQueue.then(async () => {
    if (!provider) provider = await getCurrentProvider();
    const key = cacheKeyForProvider(provider);
    const cache = await getCache(provider);
    const now = Date.now();

    // Add new entries
    for (const [url, value] of Object.entries(entries)) {
      if (typeof value === "string") {
        // Legacy format: just newTitle string
        cache[url] = { newTitle: value, ts: now };
      } else {
        // New format: { newTitle, originalTitle }
        cache[url] = { newTitle: value.newTitle, originalTitle: value.originalTitle, ts: now };
      }
    }

    // Prune expired entries
    for (const [url, entry] of Object.entries(cache)) {
      if (now - entry.ts > CONFIG.CACHE_MAX_AGE_MS) {
        delete cache[url];
      }
    }

    // Cap cache size
    const cacheEntries = Object.entries(cache);
    if (cacheEntries.length > CONFIG.CACHE_MAX_ENTRIES) {
      cacheEntries.sort((a, b) => a[1].ts - b[1].ts);
      cacheEntries.slice(0, cacheEntries.length - CONFIG.CACHE_MAX_ENTRIES).forEach(([url]) => delete cache[url]);
    }

    await chrome.storage.local.set({ [key]: cache });
  });
}

/**
 * Load cache for the current provider, migrating old format if needed.
 */
async function loadCache(provider) {
  const cache = await getCache(provider);

  // Migrate old global cache to anthropic if it exists
  const oldData = await chrome.storage.local.get("unbait_cache");
  if (oldData.unbait_cache && Object.keys(oldData.unbait_cache).length > 0) {
    const oldCache = oldData.unbait_cache;
    await setCacheEntries(
      Object.fromEntries(Object.entries(oldCache).map(([url, entry]) => [url, entry.newTitle])),
      "anthropic"
    );
    await chrome.storage.local.remove("unbait_cache");
    // Reload cache if we're on anthropic
    if (provider === "anthropic") {
      Object.assign(cache, (await getCache(provider)));
    }
  }

  return cache;
}

/**
 * Split headlines into cached and uncached, apply cached results immediately.
 */
function categorizeHeadlines(headlines, cache) {
  const uncachedData = [];
  let cachedCount = 0;

  headlines.forEach((item, index) => {
    const id = `headline-${index}`;
    _unbaitElements.set(id, item.element);
    // Only set original if not already stored (defense against race conditions)
    if (!item.element.dataset.unbaitOriginal) {
      item.element.dataset.unbaitOriginal = item.text;
    }

    // Check cache by article URL
    const cached = cache[item.url];
    if (cached && Date.now() - cached.ts < CONFIG.CACHE_MAX_AGE_MS) {
      _unbaitApplied.add(id);
      if (cached.newTitle) {
        renderReplacedHeadline(item.element, cached.newTitle, cached.originalTitle || item.text);
        cachedCount++;
      }
    } else {
      item.element.classList.add("unbait-loading");
      uncachedData.push({ id, text: item.text, url: item.url });
    }
  });

  return { uncachedData, cachedCount };
}

/**
 * Send uncached headlines to service worker, handle timeout and responses.
 */
async function fetchAndApplyResults(uncachedData, provider, cachedCount, totalFound) {
  try {
    console.debug(`[Unbait] Sending ${uncachedData.length} headlines to service worker...`);

    // Create a promise that resolves when rewrite-complete is received
    const completePromise = new Promise((resolve) => {
      _rewriteResolve = resolve;
    });

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        action: "rewrite-headlines",
        headlines: uncachedData,
      });
    } catch (e) {
      _rewriteResolve = null;
      throw e;
    }

    // Service worker responds immediately with { accepted: true }
    // or with full results (Chrome often completes before SW terminates)
    if (response && response.accepted) {
      // Wait for rewrite-complete message or timeout
      const result = await Promise.race([
        completePromise,
        new Promise((resolve) =>
          setTimeout(() => {
            _rewriteResolve = null;
            resolve({ success: true, found: totalFound, count: _unbaitApplied.size });
          }, CONFIG.API_TIMEOUT_MS)
        ),
      ]);
      _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));
      return result;
    }

    // Legacy path: full response returned directly (Chrome fast path)
    _rewriteResolve = null;

    if (!response) {
      _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));
      return { success: true, found: totalFound, count: _unbaitApplied.size };
    }

    if (response.error) {
      _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));
      return { error: response.error };
    }

    // Apply all results at once
    const newCacheEntries = {};

    if (response.results) {
      for (const result of response.results) {
        applyResult(result);
        const headline = uncachedData.find((h) => h.id === result.id);
        if (headline && result.newTitle) {
          newCacheEntries[headline.url] = { newTitle: result.newTitle, originalTitle: headline.text };
        }
      }
    }

    if (Object.keys(newCacheEntries).length > 0) {
      setCacheEntries(newCacheEntries, provider);
    }

    _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));

    let totalReplaced = 0;
    _unbaitElements.forEach((el) => {
      if (el.classList.contains("unbait-replaced")) totalReplaced++;
    });

    return { success: true, found: totalFound, count: totalReplaced };
  } catch (err) {
    _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));
    return { error: `Fout: ${err.message}` };
  }
}

async function processHeadlines() {
  const headlines = findHeadlines();

  if (headlines.length === 0) {
    return { error: "Geen koppen gevonden op deze pagina." };
  }

  // Inject G-icons immediately so users can get summaries while de-clickbait loads
  injectGistIcons();

  _unbaitElements.clear();
  _unbaitApplied.clear();

  const provider = await getCurrentProvider();
  const cache = await loadCache(provider);
  const { uncachedData, cachedCount } = categorizeHeadlines(headlines, cache);

  if (uncachedData.length === 0) {
    return { success: true, found: headlines.length, count: cachedCount, cached: true };
  }

  // Enrich with article context from content script (Safari-compatible)
  const enriched = await enrichHeadlinesWithContext(uncachedData);

  return fetchAndApplyResults(enriched, provider, cachedCount, headlines.length);
}

/**
 * Set title text without destroying image/figure children.
 * When el is an <a> containing both an image and text (news card pattern),
 * plain textContent = X would wipe out the thumbnail. Instead we find the
 * text-bearing sub-element and replace only that.
 */
function setTitleText(el, text) {
  /**
   * Replace only the visible text content of `node`, leaving all child
   * elements intact (<time>, badge spans like "ANALYSE"/"VIDEO", icons, etc.).
   * Strategy: overwrite direct text-node children with the new value and
   * blank the rest — this preserves sibling element nodes completely.
   * If the node itself is an <a>, or contains one, we apply the same
   * text-node replacement on that link so its href is preserved.
   */
  // Original replaceTextNodes — used in Step 2 on a known title-element child.
  // Replaces the first substantive text node and clears any remaining ones.
  function replaceTextNodes(node, value) {
    const textNodes = Array.from(node.childNodes).filter(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()
    );
    if (textNodes.length === 0) return false;
    textNodes[0].textContent = value;
    for (let i = 1; i < textNodes.length; i++) textNodes[i].textContent = "";
    return true;
  }

  /**
   * Apply `value` as the text of `target`, preserving all sibling element
   * children (timestamps, badges, etc.).
   *
   * Step 1 — find the longest direct text-node (> 5 chars so timestamps like
   *   "13:01" are skipped) and replace only that node, leaving everything else
   *   untouched.
   *   <a><time>13:01</time> Title text </a>  →  text-node replaced, <time> untouched.
   *   <a>13:01<strong>Title</strong></a>     →  no long text-node → falls to Step 2.
   *
   * Step 2 — no long direct text-node: find the child element with the most
   *   text (= title, always longer than a badge/timestamp) and replace that.
   *   <a>13:01<strong>Title</strong></a>  →  <strong> rewritten, "13:01" untouched.
   *
   * Step 3 — no children at all: plain textContent assignment.
   */
  function applyText(target, value) {
    // Step 1: find a substantive direct text-node and replace only that one
    let titleNode = null;
    for (const n of target.childNodes) {
      if (n.nodeType !== Node.TEXT_NODE) continue;
      const len = n.textContent.trim().length;
      if (len <= 5) continue; // skip short text like timestamps ("13:01" = 5 chars)
      if (!titleNode || len > titleNode.textContent.trim().length) titleNode = n;
    }
    if (titleNode) {
      titleNode.textContent = value;
      return;
    }

    // Step 2: pick the child element with the most text — that is the title
    let best = null;
    for (const child of target.children) {
      const len = child.textContent.trim().length;
      if (!best || len > best.textContent.trim().length) best = child;
    }
    if (best) {
      if (!replaceTextNodes(best, value)) best.textContent = value;
      return;
    }

    // Step 3: no children — set directly
    target.textContent = value;
  }

  function setTextPreservingLink(node, value) {
    if (node.tagName === "A") {
      applyText(node, value);
      return;
    }
    const link = node.querySelector("a");
    if (link) {
      applyText(link, value);
      return;
    }
    applyText(node, value);
  }

  if (!el.querySelector("img, figure, picture")) {
    setTextPreservingLink(el, text);
    return;
  }
  // Element has media — find the text-bearing child that has no media.
  // First try real heading tags; then fall back to elements with title-like
  // classes (e.g. <div class="h4 list-item-title"> on wielerflits.nl).
  const heading = el.querySelector("h1, h2, h3, h4, h5")
    || el.querySelector("[class*='title']:not([class*='sub']):not([class*='caption'])");
  if (heading && !heading.querySelector("img, figure, picture")) {
    setTextPreservingLink(heading, text);
    return;
  }
  for (const child of el.children) {
    if (!child.querySelector("img, figure, picture") && child.textContent.trim()) {
      setTextPreservingLink(child, text);
      return;
    }
  }
  // Fallback: replace direct text nodes only, leave element children intact
  let replaced = false;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      node.textContent = replaced ? "" : text;
      replaced = true;
    }
  }
  if (!replaced) el.textContent = text;
}

/**
 * Shared rendering logic for replacing a headline with a new title.
 */
function renderReplacedHeadline(el, newTitle, originalText) {
  // Preserve existing original if already set (prevents overwrite on re-render/back-nav)
  const existingOriginal = el.dataset.unbaitOriginal;
  const url = el.closest("a")?.href || el.querySelector("a")?.href;
  const mapOriginal = url && _unbaitTitles.get(url)?.original;
  const trueOriginal = existingOriginal || mapOriginal || originalText;

  // Store in Map keyed by URL — survives React DOM replacement
  if (url) {
    _unbaitTitles.set(url, { original: trueOriginal, rewritten: newTitle });
  }

  el.classList.add("unbait-replaced");
  el.title = `Origineel: ${trueOriginal}`;
  el.dataset.unbaitOriginal = trueOriginal;
  el.dataset.unbaitNew = newTitle;
  if (url) el.dataset.unbaitUrl = url;

  // Remove ALL existing icons before adding new one (handles edge-case duplicates)
  // Check self, parent (up to 3 levels), and siblings for stale G/U icons
  el.querySelectorAll(".unbait-icon, .gist-icon").forEach((n) => n.remove());
  let _p = el;
  for (let _i = 0; _i < 3 && _p; _i++) {
    if (_p.nextElementSibling?.classList.contains("gist-icon")) _p.nextElementSibling.remove();
    if (_p.nextElementSibling?.classList.contains("unbait-icon")) _p.nextElementSibling.remove();
    _p = _p.parentElement;
  }

  // Set text, then append icon inside the element
  setTitleText(el, newTitle);

  // Re-show hidden time/date elements nearby.
  // On wielerflits.nl the timestamp lives in a sibling of the title element:
  //   list-item-wrapper
  //     list-item-thumbnail
  //     list-item-time hidden  ← shown by site JS; our DOM change blocks that
  //     list-item-content
  //       list-item-title      ← el (after Strategy-3 title-class fix)
  // We walk up from el (up to 4 levels) and look for elements whose class
  // contains "time" or "date" AND have the "hidden" class, then un-hide them.
  // We stop as soon as we find at least one, to avoid touching unrelated items.
  (function () {
    let _node = el.parentElement;
    for (let _i = 0; _i < 4 && _node; _i++, _node = _node.parentElement) {
      const _hits = _node.querySelectorAll("[class*='time'].hidden, [class*='date'].hidden");
      if (_hits.length > 0) {
        _hits.forEach(function (_t) {
          _t.classList.remove("hidden");
          _t.removeAttribute("hidden");
        });
        break; // stop — don't walk further up the tree
      }
    }
  })();

  const icon = document.createElement("span");
  icon.className = "unbait-icon";
  icon.title = "Klik om origineel te tonen";
  icon.setAttribute("role", "button");
  icon.setAttribute("tabindex", "0");
  icon.setAttribute("aria-label", "Toggle original headline");
  el.appendChild(icon);
}

/**
 * Apply a single result (used by both batch and streaming).
 * Returns true if headline was replaced.
 */
function applyResult(result) {
  // Prevent double-application (streaming + batch can both fire)
  if (_unbaitApplied.has(result.id)) return false;
  _unbaitApplied.add(result.id);

  const el = _unbaitElements.get(result.id);
  if (!el) return false;

  el.classList.remove("unbait-loading");

  // null means title was already good — don't replace
  if (!result.newTitle) return false;

  const originalText = el.dataset.unbaitOriginal || el.textContent;
  renderReplacedHeadline(el, result.newTitle, originalText);

  return true;
}

/**
 * Handle streaming results — also cache them.
 */
function applyStreamResult(result) {
  if (applyResult(result)) {
    const el = _unbaitElements.get(result.id);
    if (el) {
      const url = el.closest("a")?.href || el.querySelector("a")?.href;
      if (url && result.newTitle) {
        const originalTitle = el.dataset.unbaitOriginal || el.textContent;
        setCacheEntries({ [url]: { newTitle: result.newTitle, originalTitle } });
      }
    }
  }
}

/**
 * Toggle between original and new title.
 */
function toggleTitle(el, icon) {
  // Try data attributes first, fall back to Map (survives React re-renders)
  let original = el.dataset.unbaitOriginal;
  let rewritten = el.dataset.unbaitNew;

  if (!original || !rewritten) {
    const url = el.dataset.unbaitUrl || el.closest("a")?.href;
    const stored = url && _unbaitTitles.get(url);
    if (stored) {
      original = stored.original;
      rewritten = stored.rewritten;
      // Restore data attributes
      el.dataset.unbaitOriginal = original;
      el.dataset.unbaitNew = rewritten;
    }
  }

  if (!original || !rewritten) return;

  const isShowingOriginal = icon.classList.contains("showing-original");

  if (isShowingOriginal) {
    // Show unbait title
    setTitleText(el, rewritten);
    el.title = `Origineel: ${original}`;
    icon.title = "Klik om origineel te tonen";
    icon.classList.remove("showing-original");
  } else {
    // Show original text
    setTitleText(el, original);
    el.title = `Unbait: ${rewritten}`;
    icon.title = "Klik om Unbait-titel te tonen";
    icon.classList.add("showing-original");
  }
  // Re-append icon (setTitleText on a plain text element removes child nodes)
  el.appendChild(icon);
}

// ---------------------------------------------------------------------------
// Gist: overlay, rendering, cache, click handler
// ---------------------------------------------------------------------------

function gistRenderVerdictBadge(container, line) {
  const badge = document.createElement("div");
  let color = "green";
  if (line.startsWith("\ud83d\udfe1")) color = "yellow";
  else if (line.startsWith("\ud83d\udd34")) color = "red";
  badge.className = `gist-verdict-badge ${color}`;

  const dot = document.createElement("span");
  dot.className = "gist-verdict-dot";
  badge.appendChild(dot);

  const content = line.slice(2).trim();
  const sepIdx = content.indexOf(" | ");
  const rawLabel = sepIdx >= 0 ? content.slice(0, sepIdx) : content;
  const reason = sepIdx >= 0 ? content.slice(sepIdx + 3) : "";
  const labelMatch = rawLabel.match(/\*\*([^*]+)\*\*/);
  const labelText = labelMatch ? labelMatch[1] : rawLabel;

  const label = document.createElement("span");
  label.className = "gist-verdict-label";
  label.textContent = labelText;
  badge.appendChild(label);

  if (reason) {
    const divider = document.createElement("div");
    divider.className = "gist-verdict-divider";
    badge.appendChild(divider);
    const reasonEl = document.createElement("span");
    reasonEl.className = "gist-verdict-reason";
    reasonEl.textContent = reason;
    badge.appendChild(reasonEl);
  }
  container.appendChild(badge);
}

function gistRenderText(container, text) {
  container.textContent = "";
  const lines = text.split("\n");
  let currentP = null;

  const verdictIdx = lines.findIndex((l) => /^(\ud83d\udfe2|\ud83d\udfe1|\ud83d\udd34)/.test(l.trim()));
  if (verdictIdx >= 0) gistRenderVerdictBadge(container, lines[verdictIdx].trim());

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (li === verdictIdx) continue;
    if (line.trim() === "") { currentP = null; continue; }
    if (!currentP) {
      currentP = document.createElement("p");
      container.appendChild(currentP);
    } else {
      currentP.appendChild(document.createElement("br"));
    }
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    for (const part of parts) {
      if (part.startsWith("**") && part.endsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = part.slice(2, -2);
        currentP.appendChild(strong);
      } else {
        currentP.appendChild(document.createTextNode(part));
      }
    }
  }
}

function gistShowOverlay(iconEl, url) {
  gistCloseOverlay();
  _gistActiveUrl = url;
  _gistActiveIconEl = iconEl;

  const overlay = document.createElement("div");
  overlay.className = "gist-overlay";

  const header = document.createElement("div");
  header.className = "gist-overlay-header";
  const titleEl = document.createElement("span");
  titleEl.className = "gist-overlay-title";
  titleEl.textContent = "Gist";
  const closeBtn = document.createElement("button");
  closeBtn.className = "gist-overlay-close";
  closeBtn.textContent = "\u00d7";
  closeBtn.addEventListener("click", gistCloseOverlay);
  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "gist-overlay-body";
  const loading = document.createElement("div");
  loading.className = "gist-overlay-loading";
  body.appendChild(loading);

  const footer = document.createElement("div");
  footer.className = "gist-overlay-footer";
  try { footer.textContent = new URL(url).hostname; } catch { footer.textContent = ""; }

  overlay.appendChild(header);
  overlay.appendChild(body);
  overlay.appendChild(footer);
  document.body.appendChild(overlay);
  _gistActiveOverlay = overlay;

  gistPositionOverlay(overlay, iconEl);
  document.addEventListener("keydown", _gistEscHandler);
  window.addEventListener("scroll", _gistScrollHandler, { passive: true, capture: true });
  setTimeout(() => document.addEventListener("click", _gistOutsideClickHandler), 100);
}

function gistCloseOverlay() {
  if (_gistActiveOverlay) { _gistActiveOverlay.remove(); _gistActiveOverlay = null; _gistActiveUrl = null; _gistActiveIconEl = null; }
  document.removeEventListener("keydown", _gistEscHandler);
  document.removeEventListener("click", _gistOutsideClickHandler);
  window.removeEventListener("scroll", _gistScrollHandler, { capture: true });
}

function _gistEscHandler(e) { if (e.key === "Escape") gistCloseOverlay(); }
function _gistOutsideClickHandler(e) {
  if (_gistActiveOverlay && !_gistActiveOverlay.contains(e.target) && !e.target.classList.contains("unbait-icon")) gistCloseOverlay();
}
let _gistScrollTimer = null;
function _gistScrollHandler() {
  if (!_gistActiveOverlay || !_gistActiveIconEl) return;
  if (_gistScrollTimer) clearTimeout(_gistScrollTimer);
  _gistScrollTimer = setTimeout(() => {
    if (_gistActiveOverlay && _gistActiveIconEl) gistPositionOverlay(_gistActiveOverlay, _gistActiveIconEl);
  }, 50);
}

function gistPositionOverlay(overlay, iconEl) {
  const rect = iconEl.getBoundingClientRect();
  const pad = 8;
  const ow = 380;
  const maxH = 450;
  const minVisible = 200;
  let left = rect.left;
  if (left + ow > window.innerWidth) left = window.innerWidth - ow - pad;
  if (left < pad) left = pad;
  overlay.style.left = left + "px";
  const spaceBelow = window.innerHeight - rect.bottom - pad;
  const spaceAbove = rect.top - pad;
  if (spaceBelow >= maxH || (spaceBelow >= minVisible && spaceBelow >= spaceAbove)) {
    // Below the icon — enough room, or more room than above
    overlay.style.top = (rect.bottom + pad) + "px";
    overlay.style.bottom = "";
    overlay.style.maxHeight = Math.min(maxH, spaceBelow) + "px";
  } else {
    // Above the icon — anchor bottom edge just above the icon, grows upward
    overlay.style.top = "";
    overlay.style.bottom = (window.innerHeight - rect.top + pad) + "px";
    overlay.style.maxHeight = Math.min(maxH, spaceAbove) + "px";
  }
}

// Gist cache
async function getGistCache(url) {
  const data = await chrome.storage.local.get("provider");
  const provider = data.provider || "anthropic";
  const cacheKey = `gist_cache_${provider}`;
  const cacheData = await chrome.storage.local.get(cacheKey);
  const cache = cacheData[cacheKey] || {};
  const entry = cache[url];
  if (entry && Date.now() - entry.ts < CONFIG.CACHE_MAX_AGE_MS) return entry;
  return null;
}

function cacheGistEntry(url, summary) {
  _gistCacheWriteQueue = _gistCacheWriteQueue.then(async () => {
    const data = await chrome.storage.local.get("provider");
    const provider = data.provider || "anthropic";
    const cacheKey = `gist_cache_${provider}`;
    const cacheData = await chrome.storage.local.get(cacheKey);
    const cache = cacheData[cacheKey] || {};
    cache[url] = { summary, ts: Date.now() };
    // Prune oldest entries if over limit
    const keys = Object.keys(cache);
    if (keys.length > CONFIG.CACHE_MAX_ENTRIES) {
      keys.sort((a, b) => cache[a].ts - cache[b].ts);
      for (let i = 0; i < keys.length - CONFIG.CACHE_MAX_ENTRIES; i++) delete cache[keys[i]];
    }
    await chrome.storage.local.set({ [cacheKey]: cache });
  }).catch(() => {});
}

// Gist stream/result handlers
function handleGistStream(message) {
  if (message.url !== _gistActiveUrl || !_gistActiveOverlay) return;
  const body = _gistActiveOverlay.querySelector(".gist-overlay-body");
  if (body) gistRenderText(body, message.text);
}

function handleGistResult(message) {
  _gistPendingRequests.delete(message.url);
  if (message.url !== _gistActiveUrl || !_gistActiveOverlay) {
    // Still cache even if overlay was closed
    if (message.summary) cacheGistEntry(message.url, message.summary);
    return;
  }
  const body = _gistActiveOverlay.querySelector(".gist-overlay-body");
  if (!body) return;
  if (message.error) {
    body.textContent = "";
    const errP = document.createElement("p");
    errP.style.color = "#c62828";
    errP.textContent = message.error;
    body.appendChild(errP);
  } else if (message.summary) {
    gistRenderText(body, message.summary);
    cacheGistEntry(message.url, message.summary);
  }
}

// Gist icon click handler (single click when gist enabled)
async function handleGistClick(el, icon) {
  const url = el.dataset.unbaitUrl || el.closest("a")?.href || el.querySelector("a")?.href;
  if (!url) return;
  const title = el.dataset.unbaitOriginal || el.textContent.trim();

  if (_gistActiveUrl === url && _gistActiveOverlay) { gistCloseOverlay(); return; }

  gistShowOverlay(icon, url);

  // Check cache first
  const cached = await getGistCache(url);
  if (cached) {
    if (_gistActiveOverlay && _gistActiveUrl === url) {
      const body = _gistActiveOverlay.querySelector(".gist-overlay-body");
      if (body) gistRenderText(body, cached.summary);
    }
    return;
  }

  if (_gistPendingRequests.has(url)) return;
  _gistPendingRequests.add(url);

  chrome.runtime.sendMessage({
    action: "summarize-article",
    url,
    title,
  }).catch(() => {
    _gistPendingRequests.delete(url);
    if (_gistActiveOverlay && _gistActiveUrl === url) {
      const body = _gistActiveOverlay.querySelector(".gist-overlay-body");
      if (body) {
        body.textContent = "";
        const errP = document.createElement("p");
        errP.style.color = "#c62828";
        errP.textContent = "Could not connect.";
        body.appendChild(errP);
      }
    }
  });
}

// Handle click on a G-icon (gist-only, no de-clickbaited title)
function handleGistClickFromGIcon(gIcon) {
  const url = gIcon.dataset.gistUrl;
  const title = gIcon.dataset.gistTitle;
  if (!url || !title) return;

  if (_gistActiveUrl === url && _gistActiveOverlay) { gistCloseOverlay(); return; }

  gistShowOverlay(gIcon, url);

  // Check cache first
  getGistCache(url).then((cached) => {
    if (cached) {
      if (_gistActiveOverlay && _gistActiveUrl === url) {
        const body = _gistActiveOverlay.querySelector(".gist-overlay-body");
        if (body) gistRenderText(body, cached.summary);
      }
      return;
    }

    if (_gistPendingRequests.has(url)) return;
    _gistPendingRequests.add(url);

    chrome.runtime.sendMessage({
      action: "summarize-article",
      url,
      title,
    }).catch(() => {
      _gistPendingRequests.delete(url);
      if (_gistActiveOverlay && _gistActiveUrl === url) {
        const body = _gistActiveOverlay.querySelector(".gist-overlay-body");
        if (body) {
          body.textContent = "";
          const errP = document.createElement("p");
          errP.style.color = "#c62828";
          errP.textContent = "Could not connect.";
          body.appendChild(errP);
        }
      }
    });
  });
}

/**
 * Inject G-icons on headlines that don't have a U-icon (de-clickbaited title).
 * Called after de-clickbait processing when gistEnabled is on.
 */
function injectGistIcons() {
  if (!_gistEnabled) return;
  const headlines = findHeadlines();
  for (const item of headlines) {
    const el = item.element;
    // Skip if already has icons anywhere in the element tree
    if (el.classList.contains("unbait-replaced") || el.closest(".unbait-replaced")) continue;
    if (el.querySelector(".unbait-icon, .gist-icon")) continue;
    if (el.nextElementSibling?.matches(".unbait-icon, .gist-icon")) continue;
    // Check if a child heading already has icons (parent <a> wrapping a processed <h2>)
    const childWithIcon = el.querySelector(".unbait-replaced");
    if (childWithIcon) continue;

    const gIcon = document.createElement("span");
    gIcon.className = "gist-icon";
    gIcon.title = "Get the gist";
    gIcon.setAttribute("role", "button");
    gIcon.setAttribute("tabindex", "0");
    gIcon.setAttribute("aria-label", "Show summary");
    gIcon.dataset.gistUrl = item.url;
    gIcon.dataset.gistTitle = item.text;
    el.appendChild(gIcon);
  }
}

/**
 * Generic headline detection.
 */
function findHeadlines() {
  const found = [];
  const seen = new Set();
  // Compute once — querySelectorAll("h1") is expensive to call per-headline
  const singleH1Page = document.querySelectorAll("h1").length === 1;

  // Strategy 1: <a> containing a heading (h1-h4)
  document.querySelectorAll("a h1, a h2, a h3, a h4").forEach((heading) => {
    const anchor = heading.closest("a");
    if (anchor && isValidHeadline(heading, anchor, singleH1Page)) {
      addHeadline(found, seen, heading, anchor.href);
    }
  });

  // Strategy 2: Headings (h1-h4) containing an <a>
  document.querySelectorAll("h1 a, h2 a, h3 a, h4 a").forEach((anchor) => {
    const heading = anchor.closest("h1, h2, h3, h4");
    if (heading && isValidHeadline(heading, anchor)) {
      addHeadline(found, seen, heading, anchor.href);
    }
  });

  // Strategy 3: Article-like containers with linked headings
  const containerSelectors = [
    "article",
    "[class*='article']",
    "[class*='card']",
    "[class*='story']",
    "[class*='post']",
    "[class*='teaser']",
    "[class*='item']",
    "[class*='feed']",
  ].join(", ");

  document.querySelectorAll(containerSelectors).forEach((container) => {
    if (isNavigationElement(container)) return;

    // First try real heading elements; fall back to elements with title-like
    // classes (e.g. wielerflits.nl uses <div class="h4 list-item-title">).
    const heading = container.querySelector("h1, h2, h3, h4, h5")
      || container.querySelector("[class*='title']:not([class*='sub']):not([class*='caption'])");
    if (!heading) return;

    const link =
      heading.querySelector("a") ||
      heading.closest("a") ||
      container.querySelector("a[href]");

    if (link && isValidHeadline(heading, link, singleH1Page)) {
      addHeadline(found, seen, heading, link.href);
    }
  });

  // Strategy 4: Large linked text without heading tags
  document.querySelectorAll("a[href]").forEach((anchor) => {
    if (seen.has(anchor.href)) return;

    const text = extractTitleText(anchor);
    if (
      text.length >= CONFIG.MIN_LARGE_LINK_LENGTH &&
      text.length <= CONFIG.MAX_LARGE_LINK_LENGTH &&
      !anchor.querySelector("a") &&
      !isNavigationElement(anchor) &&
      looksLikeHeadlineLink(anchor)
    ) {
      addHeadline(found, seen, anchor, anchor.href);
    }
  });

  return found;
}

/**
 * Extract clean title text from an element, stripping metadata children
 * like timestamps (<time>, "15 uur geleden"), comment counts, etc.
 * Some sites (e.g. bright.nl) nest these inside the heading element itself,
 * which causes them to bleed into the title text via textContent.
 */
function extractTitleText(element) {
  // Fast path: no metadata-like children present
  if (!element.querySelector("time, [class*='time'], [class*='date'], [class*='ago'], [class*='meta'], [class*='comment'], [class*='count'], [class*='react']")) {
    return element.textContent.trim();
  }
  // Clone and strip known metadata elements before reading text
  const clone = element.cloneNode(true);
  clone.querySelectorAll("time, [class*='time'], [class*='date'], [class*='ago'], [class*='meta'], [class*='comment'], [class*='count'], [class*='react']").forEach((n) => n.remove());
  return clone.textContent.trim();
}

function addHeadline(found, seen, element, url) {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/" || parsedUrl.pathname.length < CONFIG.MIN_PATH_LENGTH) return;
  } catch {
    return;
  }

  // Deduplicate by DOM element — prevents Strategy 4 from re-adding a parent <a>
  // that Strategy 1-3 already matched. But allows multiple elements pointing to
  // the same URL (e.g. bright.nl shows articles in both carousel and main feed).
  if (seen.has(element)) return;
  seen.add(element);

  // Skip elements already processed (self or descendant already de-clickbaited)
  if (element.classList.contains("unbait-replaced")) return;
  if (element.querySelector(".unbait-replaced")) return;
  if (element.querySelector(".unbait-icon")) return;

  const text = extractTitleText(element);
  if (!text || text.length < CONFIG.MIN_HEADLINE_LENGTH) return;

  found.push({ element, text, url });
}

function isValidHeadline(element, anchor, singleH1Page) {
  const text = extractTitleText(element);
  if (text.length < CONFIG.MIN_HEADLINE_LENGTH || text.length > CONFIG.MAX_HEADLINE_LENGTH) return false;
  if (!anchor.href || anchor.href === "#" || anchor.href === "javascript:void(0)")
    return false;
  if (isNavigationElement(element)) return false;
  if (element.tagName === "H1" && singleH1Page) return false;
  return true;
}

function isNavigationElement(el) {
  // If the element is inside an <article>, it's likely a real headline
  // even if a parent is <nav>, <aside>, <header>, etc.
  // Many sites wrap featured/trending sections in nav or aside elements.
  if (el.closest("article")) return false;

  const nav = el.closest("nav, header, footer, [role='navigation'], [role='banner'], [role='contentinfo'], aside");
  if (nav) return true;

  const identifier = ((el.className || "") + " " + (el.id || "")).toLowerCase();
  return /\b(nav|menu|breadcrumb|sidebar|footer|header|cookie|banner|skip)\b/.test(identifier);
}

function looksLikeHeadlineLink(anchor) {
  const style = window.getComputedStyle(anchor);
  const fontSize = parseFloat(style.fontSize);
  if (fontSize < CONFIG.MIN_FONT_SIZE_PX) return false;
  const rect = anchor.getBoundingClientRect();
  if (rect.width < CONFIG.MIN_LINK_WIDTH_PX || rect.height < CONFIG.MIN_LINK_HEIGHT_PX) return false;

  // Check if any ancestor (up to 5 levels) has article/card/story-like classes
  let el = anchor.parentElement;
  for (let i = 0; i < 5 && el; i++) {
    const classes = ((el.className || "") + " " + (el.id || "")).toLowerCase();
    if (/article|card|story|post|teaser|item|feed|news|content|hero|trending|featured|headline|digest|top-/.test(classes)) {
      return true;
    }
    // Also match common data attributes and roles
    if (el.getAttribute("data-testid")?.match(/card|story|post|item|feed/i)) {
      return true;
    }
    el = el.parentElement;
  }

  // Fallback: if font is large enough (>=20px), it's likely a headline
  if (fontSize >= 20 && rect.width >= 200) return true;

  return false;
}

} // end double-injection guard
