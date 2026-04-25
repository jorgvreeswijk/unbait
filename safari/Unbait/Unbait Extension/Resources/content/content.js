// Prevent double-injection — wrap everything in this guard
if (window.__unbaitLoaded) {
  // Already loaded, skip
} else {
window.__unbaitLoaded = true;

// Module state — grouped for readability
const _state = {
  isProcessing: false,
  rewriteResolve: null,
  // Store original/new titles keyed by URL — survives React re-renders
  titles: new Map(),
  // Track elements and applied results
  elements: new Map(),
  applied: new Set(),
  // Click discrimination for single/double click on icons
  clickTimer: null,
  clickTarget: null,
  // Lazy-load observer: MutationObserver + scroll listener for new DOM nodes
  contentObserver: null,
  contentObserverDebounce: null,
  contentScrollHandler: null,
};

// Gist source: hasContent flag per URL (title-only vs article-text)
const _newsGistSource = new Map();

// Gist state is managed by shared.js (window.Unbait)

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

  if (!Unbait.gistEnabled) {
    // Gist off: immediate toggle (current behavior)
    const el = icon.closest(".unbait-replaced");
    if (el) toggleTitle(el, icon);
    return;
  }

  // Gist on: single/double click discrimination
  if (_state.clickTimer && _state.clickTarget === icon) {
    // Second click within 250ms → double click
    clearTimeout(_state.clickTimer);
    _state.clickTimer = null;
    _state.clickTarget = null;
    const el = icon.closest(".unbait-replaced");
    if (el) {
      if (Unbait.gistClickMode === "title") handleGistClick(el, icon);
      else toggleTitle(el, icon);
    }
  } else {
    // First click → wait 250ms for potential second click
    _state.clickTarget = icon;
    _state.clickTimer = setTimeout(() => {
      _state.clickTimer = null;
      _state.clickTarget = null;
      // Single click
      const el = icon.closest(".unbait-replaced");
      if (el) {
        if (Unbait.gistClickMode === "title") toggleTitle(el, icon);
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
    if (_state.isProcessing) {
      sendResponse({ error: "Already processing, please wait." });
      return true;
    }
    _state.isProcessing = true;
    processHeadlines().then((result) => {
      _state.isProcessing = false;
      startContentObserving();
      sendResponse(result);
    }).catch((err) => {
      _state.isProcessing = false;
      sendResponse({ error: err.message });
    });
    return true; // async response
  }
  if (message.action === "stream-result") {
    applyStreamResult(message.result);
  }
  if (message.action === "rewrite-complete") {
    // Final results from service worker (Safari-compatible path)
    _state.isProcessing = false;
    const result = message.result;
    if (result && result.results) {
      for (const r of result.results) {
        applyResult(r);
      }
    }
    // Resolve the pending promise if any
    if (_state.rewriteResolve) {
      const found = message.found || 0;
      _state.rewriteResolve({ success: true, found, count: _state.applied.size });
      _state.rewriteResolve = null;
    }
    // Update badge with total unbaited on page (incl. cached)
    notifyBadgeCount();
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
    sendResponse({ found: (replaced + icons) > 0 ? _state.elements.size || replaced : 0, count: replaced });
  }
});

// Restore cached titles after back/forward navigation
// MutationObserver: detect when React/frameworks replace our modified elements
// and re-apply titles from the _state.titles Map
if (window.__unbaitObserver) window.__unbaitObserver.disconnect();
window.__unbaitObserver = new MutationObserver((mutations) => {
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
        const stored = url && _state.titles.get(url);
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
window.__unbaitObserver.observe(document.body, { childList: true, subtree: true });

// Multiple strategies because Safari is inconsistent about which events fire:

// Strategy 1: pageshow with persisted (standard bfcache)
window.addEventListener("pageshow", (event) => {
  if (event.persisted) restoreCachedTitles();
});

// Strategy 2: popstate (fires on back/forward in most browsers)
window.addEventListener("popstate", () => {
  if (!_state.isProcessing) restoreCachedTitles();
});

// Strategy 3: visibilitychange (fallback for Safari back-navigation)
// Only restore when there are NO replaced elements — icons on news sites are
// stable once placed and do not need re-adding on every focus switch.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !_state.isProcessing) {
    const hasUnbaitElements = document.querySelector(".unbait-replaced");
    if (!hasUnbaitElements) {
      restoreCachedTitles();
    }
  }
});

// Auto-restore cached titles on page load (for back navigation without bfcache)
// Only if not about to receive a de-clickbait message (small delay to let popup send first)
setTimeout(() => {
  if (!_state.isProcessing) restoreCachedTitles();
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

    const provider = await Unbait.Unbait.getCurrentProvider();
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
    // Update badge with total unbaited on page (incl. cached)
    notifyBadgeCount();
  } catch {
    // Silently fail — this is a best-effort restore
  } finally {
    _isRestoring = false;
  }
}

function notifyBadgeCount() {
  const count = document.querySelectorAll(".unbait-replaced").length;
  if (count > 0) {
    chrome.runtime.sendMessage({ action: "update-badge-count", count }).catch(() => {});
  }
}

// Returns the tooltip text for the Unbait icon based on current state.
// When Gist is enabled and single-click shows the summary, reflect that.
function getIconTooltip(showingOriginal) {
  const gistOn = Unbait.gistEnabled;
  const clickShowsTitle = !gistOn || Unbait.gistClickMode === "title";
  if (clickShowsTitle) {
    return showingOriginal ? "Click to show Unbait title" : "Click to show original";
  }
  // Gist on + single click shows summary
  return "Get the gist";
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
    const showingOriginal = el.textContent === el.dataset.unbaitOriginal;
    icon.title = getIconTooltip(showingOriginal);
    icon.setAttribute("role", "button");
    icon.setAttribute("tabindex", "0");
    icon.setAttribute("aria-label", "Toggle original headline");
    // Restore showing-original state
    if (showingOriginal) {
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

// _state.elements and _state.applied track elements and applied results

// Cache prefix for news content
const CACHE_PREFIX = "unbait_cache_";

function getCache(provider) {
  return Unbait.getCache(CACHE_PREFIX, provider);
}

function setCacheEntries(entries, provider) {
  Unbait.setCacheEntries(entries, CACHE_PREFIX, CONFIG.CACHE_MAX_AGE_MS, CONFIG.CACHE_MAX_ENTRIES, provider);
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
    setCacheEntries(
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
    _state.elements.set(id, item.element);
    // Only set original if not already stored (defense against race conditions)
    if (!item.element.dataset.unbaitOriginal) {
      item.element.dataset.unbaitOriginal = item.text;
    }

    // Check cache by article URL
    const cached = cache[item.url];
    if (cached && Date.now() - cached.ts < CONFIG.CACHE_MAX_AGE_MS) {
      _state.applied.add(id);
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
      _state.rewriteResolve = resolve;
    });

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        action: "rewrite-headlines",
        headlines: uncachedData,
      });
    } catch (e) {
      _state.rewriteResolve = null;
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
            _state.rewriteResolve = null;
            resolve({ success: true, found: totalFound, count: _state.applied.size });
          }, CONFIG.API_TIMEOUT_MS)
        ),
      ]);
      _state.elements.forEach((el) => el.classList.remove("unbait-loading"));
      return result;
    }

    // Legacy path: full response returned directly (Chrome fast path)
    _state.rewriteResolve = null;

    if (!response) {
      _state.elements.forEach((el) => el.classList.remove("unbait-loading"));
      return { success: true, found: totalFound, count: _state.applied.size };
    }

    if (response.error) {
      _state.elements.forEach((el) => el.classList.remove("unbait-loading"));
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

    _state.elements.forEach((el) => el.classList.remove("unbait-loading"));

    let totalReplaced = 0;
    _state.elements.forEach((el) => {
      if (el.classList.contains("unbait-replaced")) totalReplaced++;
    });

    return { success: true, found: totalFound, count: totalReplaced };
  } catch (err) {
    _state.elements.forEach((el) => el.classList.remove("unbait-loading"));
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

  _state.elements.clear();
  _state.applied.clear();

  const provider = await Unbait.getCurrentProvider();
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
  const mapOriginal = url && _state.titles.get(url)?.original;
  const trueOriginal = existingOriginal || mapOriginal || originalText;

  // Store in Map keyed by URL — survives React DOM replacement
  if (url) {
    _state.titles.set(url, { original: trueOriginal, rewritten: newTitle });
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
  icon.title = getIconTooltip(false);
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
  if (_state.applied.has(result.id)) return false;
  _state.applied.add(result.id);

  const el = _state.elements.get(result.id);
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
    const el = _state.elements.get(result.id);
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
    const stored = url && _state.titles.get(url);
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
    el.title = `Original: ${original}`;
    icon.title = getIconTooltip(false);
    icon.classList.remove("showing-original");
  } else {
    // Show original text
    setTitleText(el, original);
    el.title = `Unbait: ${rewritten}`;
    icon.title = getIconTooltip(true);
    icon.classList.add("showing-original");
  }
  // Re-append icon (setTitleText on a plain text element removes child nodes)
  el.appendChild(icon);
}

// ---------------------------------------------------------------------------
// Gist: cache prefix, click handler (news-specific)
// ---------------------------------------------------------------------------

const GIST_CACHE_PREFIX = "gist_cache_";

function getGistCache(url) {
  return Unbait.getGistCache(url, GIST_CACHE_PREFIX);
}

function cacheGistEntry(url, summary, hasContent) {
  Unbait.cacheGistEntry(url, summary, GIST_CACHE_PREFIX, CONFIG.CACHE_MAX_ENTRIES, { hasContent });
}

function newsGistUpdateFooter(footer, url, hasContent) {
  footer.textContent = "";
  const domain = document.createElement("span");
  try { domain.textContent = new URL(url).hostname; } catch { domain.textContent = ""; }
  footer.appendChild(domain);
  if (hasContent === undefined || hasContent === null) return;
  const sep = document.createElement("span");
  sep.textContent = " \u00b7 ";
  sep.style.opacity = "0.4";
  footer.appendChild(sep);
  const badge = document.createElement("span");
  badge.textContent = hasContent ? "article" : "title only";
  badge.style.fontWeight = "500";
  badge.className = hasContent ? "gist-source-transcript" : "gist-source-title";
  footer.appendChild(badge);
}

// Gist stream/result handlers
function handleGistStream(message) {
  if (message.url !== Unbait.gistActiveUrl || !Unbait.gistActiveOverlay) return;
  const body = Unbait.gistActiveOverlay.querySelector(".gist-overlay-body");
  if (body) Unbait.gistRenderText(body, message.text);
}

function handleGistResult(message) {
  Unbait.gistPendingRequests.delete(message.url);
  if (typeof message.hasContent === "boolean") {
    _newsGistSource.set(message.url, message.hasContent);
  }
  if (message.url !== Unbait.gistActiveUrl || !Unbait.gistActiveOverlay) {
    if (message.summary) cacheGistEntry(message.url, message.summary, message.hasContent);
    return;
  }
  const footer = Unbait.gistActiveOverlay.querySelector(".gist-overlay-footer");
  if (footer) newsGistUpdateFooter(footer, message.url, message.hasContent);
  const body = Unbait.gistActiveOverlay.querySelector(".gist-overlay-body");
  if (!body) return;
  if (message.error) {
    body.textContent = "";
    const errP = document.createElement("p");
    errP.style.color = "#c62828";
    errP.textContent = message.error;
    body.appendChild(errP);
  } else if (message.summary) {
    Unbait.gistRenderText(body, message.summary);
    cacheGistEntry(message.url, message.summary, message.hasContent);
  }
}

// Gist icon click handler (single click when gist enabled)
async function handleGistClick(el, icon) {
  const url = el.dataset.unbaitUrl || el.closest("a")?.href || el.querySelector("a")?.href;
  if (!url) return;
  const title = el.dataset.unbaitOriginal || el.textContent.trim();

  if (Unbait.gistActiveUrl === url && Unbait.gistActiveOverlay) { Unbait.gistCloseOverlay(); return; }

  const footerRenderer = (footer, u) => {
    const known = _newsGistSource.get(u);
    newsGistUpdateFooter(footer, u, known === undefined ? null : known);
  };
  Unbait.gistShowOverlay(icon, url, footerRenderer);

  // Check cache first
  const cached = await getGistCache(url);
  if (cached) {
    if (typeof cached.hasContent === "boolean") _newsGistSource.set(url, cached.hasContent);
    if (Unbait.gistActiveOverlay && Unbait.gistActiveUrl === url) {
      const footer = Unbait.gistActiveOverlay.querySelector(".gist-overlay-footer");
      if (footer) newsGistUpdateFooter(footer, url, cached.hasContent);
      const body = Unbait.gistActiveOverlay.querySelector(".gist-overlay-body");
      if (body) Unbait.gistRenderText(body, cached.summary);
    }
    return;
  }

  if (Unbait.gistPendingRequests.has(url)) return;
  Unbait.gistPendingRequests.add(url);

  chrome.runtime.sendMessage({
    action: "summarize-article",
    url,
    title,
  }).catch(() => {
    Unbait.gistPendingRequests.delete(url);
    if (Unbait.gistActiveOverlay && Unbait.gistActiveUrl === url) {
      const body = Unbait.gistActiveOverlay.querySelector(".gist-overlay-body");
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

  if (Unbait.gistActiveUrl === url && Unbait.gistActiveOverlay) { Unbait.gistCloseOverlay(); return; }

  const footerRenderer = (footer, u) => {
    const known = _newsGistSource.get(u);
    newsGistUpdateFooter(footer, u, known === undefined ? null : known);
  };
  Unbait.gistShowOverlay(gIcon, url, footerRenderer);

  // Check cache first
  getGistCache(url).then((cached) => {
    if (cached) {
      if (typeof cached.hasContent === "boolean") _newsGistSource.set(url, cached.hasContent);
      if (Unbait.gistActiveOverlay && Unbait.gistActiveUrl === url) {
        const footer = Unbait.gistActiveOverlay.querySelector(".gist-overlay-footer");
        if (footer) newsGistUpdateFooter(footer, url, cached.hasContent);
        const body = Unbait.gistActiveOverlay.querySelector(".gist-overlay-body");
        if (body) Unbait.gistRenderText(body, cached.summary);
      }
      return;
    }

    if (Unbait.gistPendingRequests.has(url)) return;
    Unbait.gistPendingRequests.add(url);

    chrome.runtime.sendMessage({
      action: "summarize-article",
      url,
      title,
    }).catch(() => {
      Unbait.gistPendingRequests.delete(url);
      if (Unbait.gistActiveOverlay && Unbait.gistActiveUrl === url) {
        const body = Unbait.gistActiveOverlay.querySelector(".gist-overlay-body");
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
  if (!Unbait.gistEnabled) return;
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
    "[class*='ankeiler']", // DPG Media (AD.nl, Volkskrant, Trouw, Parool)
  ].join(", ");

  document.querySelectorAll(containerSelectors).forEach((container) => {
    if (isNavigationElement(container)) return;

    // First try real heading elements; fall back to elements with title-like
    // classes (e.g. wielerflits.nl uses <div class="h4 list-item-title">).
    // Exclude wrappers whose class only incidentally contains "title"
    // (e.g. "has-long-title" on a wrapper div).
    let heading = container.querySelector("h1, h2, h3, h4, h5")
      || container.querySelector("[class*='title']:not([class*='sub']):not([class*='caption']):not([class*='wrapper'])");

    // If the container IS a heading (e.g. Guardian's h3.card-headline matches
    // [class*='card']), use the container itself as the heading and search
    // for a link in parent elements.
    if (!heading && /^H[1-5]$/.test(container.tagName)) {
      heading = container;
    }
    if (!heading) return;

    let link =
      heading.querySelector("a") ||
      heading.closest("a") ||
      container.querySelector("a[href]");

    // If no link found inside or on the container, search parent elements
    // (Guardian pattern: link is a sibling in a grandparent container)
    if (!link) {
      let parent = container.parentElement;
      for (let i = 0; i < 5 && parent && !link; i++) {
        link = parent.querySelector("a[href]");
        parent = parent.parentElement;
      }
    }

    if (link && isValidHeadline(heading, link, singleH1Page)) {
      addHeadline(found, seen, heading, link.href);
    }
  });

  // Strategy 4: Large linked text without heading tags
  // Also catches headline-class patterns:
  //   CNN:       <a><div class="container__headline">...</div></a>
  //   The Times: <a class="article-headline">...</a>
  document.querySelectorAll("a[href]").forEach((anchor) => {
    if (seen.has(anchor.href)) return;

    // Check if the anchor itself or a child has a headline-like class
    const headlineEl = anchor.matches("[class*='headline']:not([class*='sub'])")
      ? anchor
      : anchor.querySelector("[class*='headline']:not([class*='sub'])");
    if (headlineEl) {
      const text = extractTitleText(headlineEl);
      if (text.length >= CONFIG.MIN_HEADLINE_LENGTH && text.length <= CONFIG.MAX_HEADLINE_LENGTH
          && !isNavigationElement(anchor)) {
        addHeadline(found, seen, headlineEl, anchor.href);
        return;
      }
    }

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

  // Strategy 5: Utility-class sites (Tailwind, Bootstrap, etc.) — anchors
  // wrapping a bold-styled descendant. Catches sites like Duic.nl that have
  // no semantic article/card/headline class names.
  // Pattern: <a href="..."><span class="font-bold ...">Headline text</span></a>
  document.querySelectorAll("a[href]").forEach((anchor) => {
    if (seen.has(anchor) || seen.has(anchor.href)) return;
    if (isNavigationElement(anchor)) return;
    if (anchor.querySelector("a")) return; // nested anchors — skip outer
    if (anchor.querySelector(".unbait-replaced, .unbait-icon, .gist-icon")) return;
    // Skip if a descendant was already matched by an earlier strategy
    if (anchor.querySelector("h1, h2, h3, h4, h5")) return;

    const boldEl = _findBoldDescendant(anchor);
    if (!boldEl) return;

    const text = extractTitleText(boldEl);
    if (text.length < CONFIG.MIN_HEADLINE_LENGTH || text.length > CONFIG.MAX_HEADLINE_LENGTH) return;

    const rect = anchor.getBoundingClientRect();
    if (rect.width < CONFIG.MIN_LINK_WIDTH_PX || rect.height < CONFIG.MIN_LINK_HEIGHT_PX) return;
    const boldStyle = window.getComputedStyle(boldEl);
    if (parseFloat(boldStyle.fontSize) < CONFIG.MIN_FONT_SIZE_PX) return;
    // Reject ALL CAPS (usually section labels, categories, badges)
    if (text === text.toUpperCase() && text.length < 40) return;

    // Use the bold element as the headline target — cleaner text replacement
    // than using the whole anchor (which wraps images, timestamps, categories).
    addHeadline(found, seen, boldEl, anchor.href);
  });

  return found;
}

/**
 * Find a bold-weight descendant of `anchor` (or the anchor itself).
 * Checks both utility class names (font-bold, font-semibold, font-weight-bold)
 * and computed font-weight >= 600. Returns the bold element or null.
 */
function _findBoldDescendant(anchor) {
  const BOLD_CLASS_RE = /(^|\s)(font-bold|font-semibold|font-weight-bold|fw-bold|fw-semibold)(\s|$)/;
  const check = (el) => {
    const cls = el.className;
    if (typeof cls === "string" && BOLD_CLASS_RE.test(cls)) return true;
    const weight = parseInt(window.getComputedStyle(el).fontWeight, 10);
    return weight >= 600;
  };
  if (check(anchor)) return anchor;
  // Walk descendants — stop at first bold element with non-trivial text
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (el) => {
      const text = el.textContent.trim();
      if (text.length < 15) return NodeFilter.FILTER_SKIP;
      return check(el) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  return walker.nextNode();
}

/**
 * Extract clean title text from an element, stripping metadata children
 * like timestamps (<time>, "15 uur geleden"), comment counts, etc.
 * Some sites (e.g. bright.nl) nest these inside the heading element itself,
 * which causes them to bleed into the title text via textContent.
 */
function extractTitleText(element) {
  let text;
  // Fast path: no metadata-like children present
  if (!element.querySelector("time, [class*='time'], [class*='date'], [class*='ago'], [class*='meta'], [class*='comment'], [class*='count'], [class*='react']")) {
    text = element.textContent;
  } else {
    // Clone and strip known metadata elements before reading text
    const clone = element.cloneNode(true);
    clone.querySelectorAll("time, [class*='time'], [class*='date'], [class*='ago'], [class*='meta'], [class*='comment'], [class*='count'], [class*='react']").forEach((n) => n.remove());
    text = clone.textContent;
  }
  // Strip soft hyphens (used by DPG Media sites like AD.nl for responsive word-breaking)
  return text.replace(/\u00AD/g, "").trim();
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

// ---------------------------------------------------------------------------
// Lazy-load observer: MutationObserver + scroll listener for new DOM nodes
// Generic pattern — runs for any site, picks up headlines as they enter DOM.
// ---------------------------------------------------------------------------

function startContentObserving() {
  if (_state.contentObserver) return;

  const processNewTitles = () => {
    if (_state.isProcessing) return;
    const headlines = findHeadlines();
    if (headlines.length === 0) return;

    _state.isProcessing = true;
    processHeadlines()
      .then(() => { _state.isProcessing = false; })
      .catch(() => { _state.isProcessing = false; });
  };

  _state.contentObserver = new MutationObserver(() => {
    if (_state.contentObserverDebounce) clearTimeout(_state.contentObserverDebounce);
    _state.contentObserverDebounce = setTimeout(processNewTitles, 400);
  });
  _state.contentObserver.observe(document.body, { childList: true, subtree: true });

  let scrollDebounce = null;
  _state.contentScrollHandler = () => {
    if (scrollDebounce) clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(processNewTitles, 300);
  };
  window.addEventListener("scroll", _state.contentScrollHandler, { passive: true });
}

function stopContentObserving() {
  if (!_state.contentObserver) return;
  _state.contentObserver.disconnect();
  _state.contentObserver = null;
  if (_state.contentObserverDebounce) {
    clearTimeout(_state.contentObserverDebounce);
    _state.contentObserverDebounce = null;
  }
  if (_state.contentScrollHandler) {
    window.removeEventListener("scroll", _state.contentScrollHandler);
    _state.contentScrollHandler = null;
  }
}

async function checkContentAlwaysOn() {
  try {
    // YouTube has its own observer in youtube.js — don't compete.
    const host = window.location.hostname;
    if (/(^|\.)youtube\.com$/.test(host)) return;

    const data = await chrome.storage.local.get("alwaysOnSites");
    const sites = data.alwaysOnSites || [];
    const match = sites.some((s) => {
      if (!s) return false;
      return host === s || host.endsWith("." + s) || host.endsWith(s);
    });
    if (match) startContentObserving();
    else stopContentObserving();
  } catch { /* ignore */ }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.alwaysOnSites) checkContentAlwaysOn();
});

checkContentAlwaysOn();

} // end double-injection guard
