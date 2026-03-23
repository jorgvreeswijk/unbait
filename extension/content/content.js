// Prevent double-injection — wrap everything in this guard
if (window.__unbaitLoaded) {
  // Already loaded, skip
} else {
window.__unbaitLoaded = true;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "de-clickbait") {
    processHeadlines().then(sendResponse);
    return true; // async response
  }
  if (message.action === "stream-result") {
    applyStreamResult(message.result);
  }
  if (message.action === "get-stats") {
    const replaced = document.querySelectorAll(".unbait-replaced").length;
    const icons = document.querySelectorAll(".unbait-icon").length;
    sendResponse({ found: replaced + icons > 0 ? _unbaitElements.size || replaced : 0, count: replaced });
  }
});

// Restore cached titles after back/forward navigation (bfcache)
window.addEventListener("pageshow", (event) => {
  if (event.persisted) restoreIcons();
});

// Auto-restore cached titles on page load (for back navigation without bfcache)
restoreCachedTitles();

/**
 * Auto-restore cached titles on page load.
 * Scans all headlines on the page and applies cached titles if found.
 * This runs automatically when the content script loads, so previously
 * de-clickbaited pages show their improved titles after back-navigation.
 */
async function restoreCachedTitles() {
  try {
    const headlines = findHeadlines();
    if (headlines.length === 0) return;

    const provider = await getCurrentProvider();
    const cache = await getCache(provider);
    if (!cache || Object.keys(cache).length === 0) return;

    let restoredCount = 0;
    for (const item of headlines) {
      const cached = cache[item.url];
      if (cached && cached.newTitle && Date.now() - cached.ts < CONFIG.CACHE_MAX_AGE_MS) {
        renderReplacedHeadline(item.element, cached.newTitle, item.text);
        restoredCount++;
      }
    }

    if (restoredCount > 0) {
      console.debug(`[Unbait] Restored ${restoredCount} cached titles`);
    }
  } catch {
    // Silently fail — this is a best-effort restore
  }
}

function restoreIcons() {
  document.querySelectorAll(".unbait-replaced").forEach((el) => {
    if (!el.parentNode?.querySelector(".unbait-icon") && el.dataset.unbaitNew) {
      const icon = document.createElement("span");
      icon.className = "unbait-icon";
      icon.title = "Click to show original";
      icon.setAttribute("role", "button");
      icon.setAttribute("tabindex", "0");
      icon.setAttribute("aria-label", "Toggle original headline");
      icon.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleTitle(el, icon);
      });
      icon.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          icon.click();
        }
      });
      el.parentNode.insertBefore(icon, el.nextSibling);
    }
  });
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
};

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
    for (const [url, newTitle] of Object.entries(entries)) {
      cache[url] = { newTitle, ts: now };
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
    item.element.dataset.unbaitOriginal = item.text;

    // Check cache by article URL
    const cached = cache[item.url];
    if (cached && Date.now() - cached.ts < CONFIG.CACHE_MAX_AGE_MS) {
      _unbaitApplied.add(id);
      if (cached.newTitle) {
        renderReplacedHeadline(item.element, cached.newTitle, item.text);
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

    let response;
    try {
      response = await Promise.race([
        chrome.runtime.sendMessage({
          action: "rewrite-headlines",
          headlines: uncachedData,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), CONFIG.API_TIMEOUT_MS)),
      ]);
    } catch (e) {
      if (e.message === "timeout") {
        console.warn("[Unbait] Response timed out, but stream-results may have been applied");
        _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));
        return { success: true, found: totalFound, count: _unbaitApplied.size };
      }
      throw e;
    }


    if (!response) {
      _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));
      return { success: true, found: totalFound, count: _unbaitApplied.size };
    }

    if (response.error) {
      _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));
      return { error: response.error };
    }

    // For non-streaming fallback: apply all results at once
    const newCacheEntries = {};

    if (response.results) {
      for (const result of response.results) {
        applyResult(result);
        const headline = uncachedData.find((h) => h.id === result.id);
        if (headline) {
          newCacheEntries[headline.url] = result.newTitle;
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

  _unbaitElements.clear();
  _unbaitApplied.clear();

  const provider = await getCurrentProvider();
  const cache = await loadCache(provider);
  const { uncachedData, cachedCount } = categorizeHeadlines(headlines, cache);

  if (uncachedData.length === 0) {
    return { success: true, found: headlines.length, count: cachedCount, cached: true };
  }

  return fetchAndApplyResults(uncachedData, provider, cachedCount, headlines.length);
}

/**
 * Shared rendering logic for replacing a headline with a new title.
 */
function renderReplacedHeadline(el, newTitle, originalText) {
  el.textContent = newTitle;
  el.classList.add("unbait-replaced");
  el.title = `Origineel: ${originalText}`;
  el.dataset.unbaitOriginal = originalText;
  el.dataset.unbaitNew = newTitle;

  const existingIcon = el.parentNode?.querySelector(".unbait-icon");
  if (existingIcon) existingIcon.remove();

  const icon = document.createElement("span");
  icon.className = "unbait-icon";
  icon.title = "Klik om origineel te tonen";
  icon.setAttribute("role", "button");
  icon.setAttribute("tabindex", "0");
  icon.setAttribute("aria-label", "Toggle original headline");
  icon.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleTitle(el, icon);
  });
  icon.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      icon.click();
    }
  });
  el.parentNode.insertBefore(icon, el.nextSibling);
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
    // Find the URL for this headline to cache it
    for (const [id, el] of _unbaitElements) {
      if (id === result.id) {
        const url = el.closest("a")?.href || el.querySelector("a")?.href;
        if (url && result.newTitle) {
          setCacheEntries({ [url]: result.newTitle });
        }
        break;
      }
    }
  }
}

/**
 * Toggle between original and new title.
 */
function toggleTitle(el, icon) {
  const isShowingOriginal = icon.classList.contains("showing-original");

  if (isShowingOriginal) {
    // Switch back to new title
    el.textContent = el.dataset.unbaitNew;
    el.title = `Origineel: ${el.dataset.unbaitOriginal}`;
    icon.title = "Klik om origineel te tonen";
    icon.classList.remove("showing-original");
  } else {
    // Show original
    el.textContent = el.dataset.unbaitOriginal;
    el.title = `Unbait: ${el.dataset.unbaitNew}`;
    icon.title = "Klik om Unbait-titel te tonen";
    icon.classList.add("showing-original");
  }
}

/**
 * Generic headline detection.
 */
function findHeadlines() {
  const found = [];
  const seen = new Set();

  // Strategy 1: <a> containing a heading (h1-h4)
  document.querySelectorAll("a h1, a h2, a h3, a h4").forEach((heading) => {
    const anchor = heading.closest("a");
    if (anchor && isValidHeadline(heading, anchor)) {
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

    const heading = container.querySelector("h1, h2, h3, h4, h5");
    if (!heading) return;

    const link =
      heading.querySelector("a") ||
      heading.closest("a") ||
      container.querySelector("a[href]");

    if (link && isValidHeadline(heading, link)) {
      addHeadline(found, seen, heading, link.href);
    }
  });

  // Strategy 4: Large linked text without heading tags
  document.querySelectorAll("a[href]").forEach((anchor) => {
    if (seen.has(anchor.href)) return;

    const text = anchor.textContent.trim();
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

function addHeadline(found, seen, element, url) {
  const text = element.textContent.trim();
  if (!text || text.length < CONFIG.MIN_HEADLINE_LENGTH || seen.has(url)) return;

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/" || parsedUrl.pathname.length < CONFIG.MIN_PATH_LENGTH) return;
  } catch {
    return;
  }

  seen.add(url);
  found.push({ element, text, url });
}

function isValidHeadline(element, anchor) {
  const text = element.textContent.trim();
  if (text.length < CONFIG.MIN_HEADLINE_LENGTH || text.length > CONFIG.MAX_HEADLINE_LENGTH) return false;
  if (!anchor.href || anchor.href === "#" || anchor.href === "javascript:void(0)")
    return false;
  if (isNavigationElement(element)) return false;
  if (element.tagName === "H1" && document.querySelectorAll("h1").length === 1)
    return false;
  return true;
}

function isNavigationElement(el) {
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
  const parent = anchor.parentElement;
  if (!parent) return false;
  const parentClasses = (parent.className || "").toLowerCase();
  return /article|card|story|post|teaser|item|feed|news|content/.test(parentClasses);
}

} // end double-injection guard
