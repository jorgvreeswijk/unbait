// Prevent double-injection
if (!window.__unbaitLoaded) {
  window.__unbaitLoaded = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "de-clickbait") {
      processHeadlines().then(sendResponse);
      return true; // async response
    }
    if (message.action === "stream-result") {
      applyStreamResult(message.result);
    }
  });
}

// Global maps to track elements and applied results
const _unbaitElements = new Map();
const _unbaitApplied = new Set();

// Cache: per-provider, article URL → { newTitle, timestamp }
const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

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
    if (now - entry.ts > CACHE_MAX_AGE) {
      delete cache[url];
    }
  }

  await chrome.storage.local.set({ [key]: cache });
}

async function processHeadlines() {
  const headlines = findHeadlines();

  if (headlines.length === 0) {
    return { error: "Geen koppen gevonden op deze pagina." };
  }

  _unbaitElements.clear();
  _unbaitApplied.clear();

  // Load cache for current provider
  const provider = await getCurrentProvider();
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

  const headlineData = [];
  const uncachedData = [];
  let cachedCount = 0;

  headlines.forEach((item, index) => {
    const id = `headline-${index}`;
    headlineData.push({ id, text: item.text, url: item.url });
    _unbaitElements.set(id, item.element);
    item.element.dataset.unbaitOriginal = item.text;

    // Check cache by article URL
    const cached = cache[item.url];
    if (cached && Date.now() - cached.ts < CACHE_MAX_AGE) {
      // Apply cached result immediately (no loading state needed)
      const result = { id, newTitle: cached.newTitle };
      _unbaitApplied.add(id);
      if (cached.newTitle) {
        applyCachedResult(item.element, cached.newTitle, item.text);
        cachedCount++;
      }
    } else {
      // Needs API call — show loading state
      item.element.classList.add("unbait-loading");
      uncachedData.push({ id, text: item.text, url: item.url });
    }
  });

  // If everything was cached, we're done
  if (uncachedData.length === 0) {
    return { success: true, found: headlines.length, count: cachedCount, cached: true };
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: "rewrite-headlines",
      headlines: uncachedData,
    });

    if (response.error) {
      _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));
      return { error: response.error };
    }

    // For non-streaming fallback: apply all results at once
    let replacedCount = cachedCount;
    const newCacheEntries = {};

    if (response.results) {
      for (const result of response.results) {
        if (applyResult(result)) replacedCount++;
        // Cache the result by article URL
        const headline = uncachedData.find((h) => h.id === result.id);
        if (headline) {
          newCacheEntries[headline.url] = result.newTitle;
        }
      }
    }

    // Save new results to cache (for current provider)
    if (Object.keys(newCacheEntries).length > 0) {
      setCacheEntries(newCacheEntries, provider);
    }

    // Clean up any remaining loading states
    _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));

    return { success: true, found: headlines.length, count: replacedCount };
  } catch (err) {
    _unbaitElements.forEach((el) => el.classList.remove("unbait-loading"));
    return { error: `Fout: ${err.message}` };
  }
}

/**
 * Apply a cached result (no loading state, immediate).
 */
function applyCachedResult(el, newTitle, originalText) {
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
  icon.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleTitle(el, icon);
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
  el.textContent = result.newTitle;
  el.classList.add("unbait-replaced");
  el.title = `Origineel: ${originalText}`;
  el.dataset.unbaitOriginal = originalText;
  el.dataset.unbaitNew = result.newTitle;

  // Add clickable icon (remove any existing one first to prevent duplicates)
  const existingIcon = el.parentNode?.querySelector(".unbait-icon");
  if (existingIcon) existingIcon.remove();

  const icon = document.createElement("span");
  icon.className = "unbait-icon";
  icon.title = "Klik om origineel te tonen";
  icon.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleTitle(el, icon);
  });
  el.parentNode.insertBefore(icon, el.nextSibling);

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
      text.length >= 30 &&
      text.length <= 200 &&
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
  if (!text || text.length < 15 || seen.has(url)) return;

  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === "/" || parsedUrl.pathname.length < 5) return;
  } catch {
    return;
  }

  seen.add(url);
  found.push({ element, text, url });
}

function isValidHeadline(element, anchor) {
  const text = element.textContent.trim();
  if (text.length < 15 || text.length > 300) return false;
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
  if (fontSize < 16) return false;
  const rect = anchor.getBoundingClientRect();
  if (rect.width < 100 || rect.height < 20) return false;
  const parent = anchor.parentElement;
  if (!parent) return false;
  const parentClasses = (parent.className || "").toLowerCase();
  return /article|card|story|post|teaser|item|feed|news|content/.test(parentClasses);
}
