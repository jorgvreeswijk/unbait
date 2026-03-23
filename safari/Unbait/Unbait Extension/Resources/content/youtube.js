// Guard: only run setup once, but re-register message listener on re-injection
if (window.__unbaitYouTubeLoaded) {
  // Script already loaded — just make sure message listener is active
  // (Chrome re-runs the script, so this new execution context needs a listener)
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "de-clickbait-youtube") {
      if (window.__unbaitYTProcess) {
        window.__unbaitYTProcess().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
        return true;
      }
      sendResponse({ error: "YouTube script not ready." });
      return true;
    }
  });
} else {
window.__unbaitYouTubeLoaded = true;

let _ytIsProcessing = false;
let _ytRewriteResolve = null;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const YT_CONFIG = {
  CACHE_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  CACHE_MAX_ENTRIES: 500,
  API_TIMEOUT_MS: 120000,
  TRANSCRIPT_CONCURRENCY: 6,
  TRANSCRIPT_TIMEOUT_MS: 5000,
  TRANSCRIPT_MAX_CHARS: 1000,
  TRANSCRIPT_MAX_TIME_MS: 120000, // first ~2 minutes of captions
  DESCRIPTION_MAX_CHARS: 500,
  MIN_TITLE_LENGTH: 5,
  OBSERVER_DEBOUNCE_MS: 800,
};

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "de-clickbait-youtube") {
    if (_ytIsProcessing) {
      sendResponse({ error: "Already processing, please wait." });
      return true;
    }
    _ytIsProcessing = true;
    processYouTubeTitles()
      .then((result) => {
        _ytIsProcessing = false;
        sendResponse(result);
      })
      .catch((err) => {
        _ytIsProcessing = false;
        sendResponse({ error: err.message });
      });
    return true; // async response
  }

  if (message.action === "yt-stream-result") {
    applyStreamResult(message.result);
  }

  if (message.action === "yt-rewrite-complete") {
    _ytIsProcessing = false;
    const result = message.result;
    if (result && result.results) {
      for (const r of result.results) {
        applyResult(r);
      }
    }
    if (_ytRewriteResolve) {
      const found = message.found || 0;
      _ytRewriteResolve({ success: true, found, count: _ytApplied.size });
      _ytRewriteResolve = null;
    }
  }

  if (message.action === "get-stats") {
    const replaced = document.querySelectorAll(".unbait-replaced").length;
    const icons = document.querySelectorAll(".unbait-icon").length;
    sendResponse({
      found: replaced + icons > 0 ? _ytElements.size || replaced : 0,
      count: replaced,
    });
  }
});

// ---------------------------------------------------------------------------
// Cache navigation restore (SPA-aware)
// ---------------------------------------------------------------------------

window.addEventListener("pageshow", (event) => {
  if (event.persisted) restoreCachedTitles();
});

window.addEventListener("popstate", () => {
  if (!_ytIsProcessing) restoreCachedTitles();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !_ytIsProcessing) {
    const hasUnbait = document.querySelector(".unbait-replaced");
    if (!hasUnbait) {
      restoreCachedTitles();
    } else {
      restoreIcons();
    }
  }
});

// Auto-restore on load (small delay so popup can send de-clickbait first)
setTimeout(() => {
  if (!_ytIsProcessing) restoreCachedTitles();
}, 200);

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const _ytElements = new Map();
const _ytApplied = new Set();
let _ytCacheWriteQueue = Promise.resolve();

// ---------------------------------------------------------------------------
// Cache helpers (mirrored from content.js, YouTube-specific key)
// ---------------------------------------------------------------------------

function cacheKeyForProvider(provider) {
  return `unbait_yt_cache_${provider || "anthropic"}`;
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
  _ytCacheWriteQueue = _ytCacheWriteQueue.then(async () => {
    if (!provider) provider = await getCurrentProvider();
    const key = cacheKeyForProvider(provider);
    const cache = await getCache(provider);
    const now = Date.now();

    for (const [url, newTitle] of Object.entries(entries)) {
      cache[url] = { newTitle, ts: now };
    }

    // Prune expired
    for (const [url, entry] of Object.entries(cache)) {
      if (now - entry.ts > YT_CONFIG.CACHE_MAX_AGE_MS) {
        delete cache[url];
      }
    }

    // Cap size
    const cacheEntries = Object.entries(cache);
    if (cacheEntries.length > YT_CONFIG.CACHE_MAX_ENTRIES) {
      cacheEntries.sort((a, b) => a[1].ts - b[1].ts);
      cacheEntries
        .slice(0, cacheEntries.length - YT_CONFIG.CACHE_MAX_ENTRIES)
        .forEach(([url]) => delete cache[url]);
    }

    await chrome.storage.local.set({ [key]: cache });
  });
}

async function loadCache(provider) {
  return getCache(provider);
}

// ---------------------------------------------------------------------------
// Restore cached titles
// ---------------------------------------------------------------------------

async function restoreCachedTitles() {
  try {
    const titles = findYouTubeTitles();
    if (titles.length === 0) return;

    const provider = await getCurrentProvider();
    const cache = await getCache(provider);
    if (!cache || Object.keys(cache).length === 0) return;

    let restoredCount = 0;
    for (const item of titles) {
      const cached = cache[item.url];
      if (cached && cached.newTitle && Date.now() - cached.ts < YT_CONFIG.CACHE_MAX_AGE_MS) {
        renderReplacedHeadline(item.element, cached.newTitle, item.text);
        restoredCount++;
      }
    }

    if (restoredCount > 0) {
      console.debug(`[Unbait YT] Restored ${restoredCount} cached titles`);
    }
  } catch {
    // Best-effort restore
  }
}

function restoreIcons() {
  document.querySelectorAll(".unbait-replaced").forEach((el) => {
    const existingIcon = el.parentNode?.querySelector(".unbait-icon");
    if (existingIcon) {
      existingIcon.remove();
    }
    if (el.dataset.unbaitNew) {
      const icon = document.createElement("span");
      icon.className = "unbait-icon";
      icon.title = "Click to show original";
      icon.setAttribute("role", "button");
      icon.setAttribute("tabindex", "0");
      icon.setAttribute("aria-label", "Toggle original headline");
      if (el.textContent === el.dataset.unbaitOriginal) {
        icon.classList.add("showing-original");
      }
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

// ---------------------------------------------------------------------------
// Find YouTube video titles
// ---------------------------------------------------------------------------

const YT_TITLE_SELECTORS = [
  "ytd-rich-item-renderer h3",                   // Homepage grid (2026 layout)
  "ytd-rich-grid-media h3",                      // Homepage grid (alternate)
  "ytd-video-renderer h3",                       // Search results
  "ytd-compact-video-renderer h3",               // Sidebar suggestions
  "ytd-playlist-video-renderer h3",              // Playlist
  "ytd-grid-video-renderer h3",                  // Channel page grid
  "ytd-rich-grid-media #video-title",            // Legacy layout
  "ytd-video-renderer #video-title",             // Legacy search
  "#video-title",                                // Catch-all fallback
];

function findYouTubeTitles() {
  const found = [];
  const seen = new Set();

  for (const sel of YT_TITLE_SELECTORS) {
    document.querySelectorAll(sel).forEach((el) => {
      // Find the video link — may be on the element, a parent, or a sibling
      let href = "";
      const anchor = el.closest("a") || el.querySelector("a");
      if (anchor) {
        href = anchor.href;
      } else {
        // New YouTube layout: link is in a sibling or parent container
        const container = el.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, yt-lockup-view-model");
        if (container) {
          const link = container.querySelector('a[href*="/watch"], a[href*="/shorts/"]');
          if (link) href = link.href;
        }
      }

      const videoId = extractVideoId(href);
      if (!videoId || seen.has(videoId)) return;
      seen.add(videoId);

      const text = el.textContent.trim();
      if (text.length < YT_CONFIG.MIN_TITLE_LENGTH) return;

      found.push({
        element: el,
        text,
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      });
    });
  }

  return found;
}

function extractVideoId(url) {
  if (!url) return null;
  const match =
    url.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
    url.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Transcript fetching
// ---------------------------------------------------------------------------

async function fetchTranscript(videoId) {
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    if (!resp.ok) return null;
    const html = await resp.text();

    // Extract ytInitialPlayerResponse
    const match = html.match(
      /ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script)/s
    );
    if (!match) return null;

    const data = JSON.parse(match[1]);

    // Get caption tracks
    const tracks =
      data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) {
      // Fallback: use video description
      const desc = data?.videoDetails?.shortDescription;
      return desc ? desc.slice(0, YT_CONFIG.DESCRIPTION_MAX_CHARS) : null;
    }

    // Prefer manual captions > auto-generated, prefer user language
    const userLang = navigator.language.split("-")[0];
    const preferred =
      tracks.find((t) => t.languageCode === userLang && t.kind !== "asr") ||
      tracks.find((t) => t.languageCode === userLang) ||
      tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ||
      tracks.find((t) => t.languageCode === "en") ||
      tracks[0];

    // Fetch transcript
    const captionResp = await fetch(preferred.baseUrl + "&fmt=json3");
    if (!captionResp.ok) return null;
    const captionData = await captionResp.json();

    // Extract text from first ~2 minutes
    const events = captionData.events || [];
    let text = "";
    for (const ev of events) {
      if (ev.segs) {
        text += ev.segs.map((s) => s.utf8).join("");
      }
      if (ev.tStartMs && ev.tStartMs > YT_CONFIG.TRANSCRIPT_MAX_TIME_MS) break;
    }

    return (
      text
        .replace(/\n/g, " ")
        .trim()
        .slice(0, YT_CONFIG.TRANSCRIPT_MAX_CHARS) || null
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enrich titles with transcript context (parallel, limited concurrency)
// ---------------------------------------------------------------------------

async function enrichWithTranscripts(titles) {
  const enrichOne = async (item) => {
    if (item.context) return;
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        YT_CONFIG.TRANSCRIPT_TIMEOUT_MS
      );
      const transcript = await fetchTranscript(item.videoId);
      clearTimeout(timer);
      if (transcript) item.context = transcript;
    } catch {
      // Silently skip failed transcripts
    }
  };

  for (
    let i = 0;
    i < titles.length;
    i += YT_CONFIG.TRANSCRIPT_CONCURRENCY
  ) {
    const batch = titles.slice(i, i + YT_CONFIG.TRANSCRIPT_CONCURRENCY);
    await Promise.all(batch.map(enrichOne));
  }

  const withContext = titles.filter((t) => t.context).length;
  console.debug(
    `[Unbait YT] Transcripts: ${withContext}/${titles.length}`
  );
}

// ---------------------------------------------------------------------------
// Thumbnail replacement (optional, MVP: dim + grayscale)
// ---------------------------------------------------------------------------

function replaceThumbnail(videoId, container) {
  const img = container.querySelector("ytd-thumbnail img, #thumbnail img");
  if (!img || img.dataset.unbaitThumb) return;

  img.dataset.unbaitThumb = "true";
  img.style.filter = "blur(2px) grayscale(0.5)";
  img.style.opacity = "0.7";
}

// ---------------------------------------------------------------------------
// Render / apply / toggle (self-contained, mirrors content.js)
// ---------------------------------------------------------------------------

function renderReplacedHeadline(el, newTitle, originalText) {
  // YouTube's data-binding framework re-renders text content, overriding our changes.
  // Solution: clone the text element to break YouTube's binding, then set our text.
  const textTarget =
    el.querySelector("span.yt-core-attributed-string") ||
    el.querySelector("yt-formatted-string") ||
    el.querySelector("span") ||
    el;

  // Clone the element to break YouTube's data binding
  const clone = textTarget.cloneNode(false); // shallow clone — no children
  clone.textContent = newTitle;
  if (textTarget.parentNode) {
    textTarget.parentNode.replaceChild(clone, textTarget);
  }

  // Also update the parent <a> aria-label
  const titleLink = el.querySelector("a.yt-lockup-metadata-view-model__title");
  if (titleLink) {
    titleLink.setAttribute("aria-label", newTitle);
    // Clone the link too to prevent YouTube from restoring via its binding
    const linkClone = titleLink.cloneNode(true);
    // Update text in the cloned link
    const innerSpan = linkClone.querySelector("span.yt-core-attributed-string, span");
    if (innerSpan) innerSpan.textContent = newTitle;
    if (titleLink.parentNode) {
      titleLink.parentNode.replaceChild(linkClone, titleLink);
    }
  }

  el.classList.add("unbait-replaced");
  el.title = `Original: ${originalText}`;
  el.dataset.unbaitOriginal = originalText;
  el.dataset.unbaitNew = newTitle;

  // Mark the renderer container so MutationObserver skips it
  const renderer = el.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer");
  if (renderer) renderer.dataset.unbaitProcessed = "true";

  const existingIcon = el.parentNode?.querySelector(".unbait-icon");
  if (existingIcon) existingIcon.remove();

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

function applyResult(result) {
  if (_ytApplied.has(result.id)) return false;
  _ytApplied.add(result.id);

  const el = _ytElements.get(result.id);
  if (!el) return false;

  el.classList.remove("unbait-loading");

  // null means title was already good
  if (!result.newTitle) return false;

  const originalText = el.dataset.unbaitOriginal || el.textContent;
  renderReplacedHeadline(el, result.newTitle, originalText);

  return true;
}

function applyStreamResult(result) {
  if (applyResult(result)) {
    for (const [id, el] of _ytElements) {
      if (id === result.id) {
        const videoId = el.dataset.unbaitVideoId;
        if (videoId && result.newTitle) {
          const url = `https://www.youtube.com/watch?v=${videoId}`;
          setCacheEntries({ [url]: result.newTitle });
        }
        break;
      }
    }
  }
}

function toggleTitle(el, icon) {
  const target = el.querySelector("span.yt-core-attributed-string") || el.querySelector("yt-formatted-string") || el;
  const isShowingOriginal = icon.classList.contains("showing-original");

  if (isShowingOriginal) {
    target.textContent = el.dataset.unbaitNew;
    el.title = `Original: ${el.dataset.unbaitOriginal}`;
    icon.title = "Click to show original";
    icon.classList.remove("showing-original");
  } else {
    target.textContent = el.dataset.unbaitOriginal;
    el.title = `Unbait: ${el.dataset.unbaitNew}`;
    icon.title = "Click to show Unbait title";
    icon.classList.add("showing-original");
  }
}

// ---------------------------------------------------------------------------
// Categorize headlines: cached vs uncached
// ---------------------------------------------------------------------------

function categorizeHeadlines(titles, cache) {
  const uncachedData = [];
  let cachedCount = 0;

  titles.forEach((item) => {
    const id = `yt-${item.videoId}`;
    _ytElements.set(id, item.element);
    item.element.dataset.unbaitOriginal = item.text;
    item.element.dataset.unbaitVideoId = item.videoId;

    const cached = cache[item.url];
    if (cached && Date.now() - cached.ts < YT_CONFIG.CACHE_MAX_AGE_MS) {
      _ytApplied.add(id);
      if (cached.newTitle) {
        renderReplacedHeadline(item.element, cached.newTitle, item.text);
        cachedCount++;
      }
    } else {
      item.element.classList.add("unbait-loading");
      uncachedData.push({
        id,
        text: item.text,
        url: item.url,
        videoId: item.videoId,
      });
    }
  });

  return { uncachedData, cachedCount };
}

// ---------------------------------------------------------------------------
// Send to service worker, handle response
// ---------------------------------------------------------------------------

async function fetchAndApplyResults(
  uncachedData,
  provider,
  cachedCount,
  totalFound
) {
  try {
    console.debug(
      `[Unbait YT] Sending ${uncachedData.length} titles to service worker...`
    );

    const completePromise = new Promise((resolve) => {
      _ytRewriteResolve = resolve;
    });

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        action: "rewrite-youtube-titles",
        headlines: uncachedData.map((h) => ({
          id: h.id,
          text: h.text,
          url: h.url,
          context: h.context || undefined,
        })),
      });
    } catch (e) {
      _ytRewriteResolve = null;
      throw e;
    }

    if (response && response.accepted) {
      const result = await Promise.race([
        completePromise,
        new Promise((resolve) =>
          setTimeout(() => {
            _ytRewriteResolve = null;
            resolve({
              success: true,
              found: totalFound,
              count: _ytApplied.size,
            });
          }, YT_CONFIG.API_TIMEOUT_MS)
        ),
      ]);
      _ytElements.forEach((el) => el.classList.remove("unbait-loading"));
      return result;
    }

    // Legacy path: full response returned directly
    _ytRewriteResolve = null;

    if (!response) {
      _ytElements.forEach((el) => el.classList.remove("unbait-loading"));
      return { success: true, found: totalFound, count: _ytApplied.size };
    }

    if (response.error) {
      _ytElements.forEach((el) => el.classList.remove("unbait-loading"));
      return { error: response.error };
    }

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

    _ytElements.forEach((el) => el.classList.remove("unbait-loading"));

    let totalReplaced = 0;
    _ytElements.forEach((el) => {
      if (el.classList.contains("unbait-replaced")) totalReplaced++;
    });

    return { success: true, found: totalFound, count: totalReplaced };
  } catch (err) {
    _ytElements.forEach((el) => el.classList.remove("unbait-loading"));
    return { error: `Error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Main: processYouTubeTitles
// ---------------------------------------------------------------------------

// Expose for re-injection access
window.__unbaitYTProcess = processYouTubeTitles;

async function processYouTubeTitles() {
  // YouTube loads content dynamically — wait for titles to appear
  let titles = findYouTubeTitles();
  if (titles.length === 0) {
    for (let attempt = 0; attempt < 10 && titles.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      titles = findYouTubeTitles();
    }
  }

  if (titles.length === 0) {
    return { error: "No video titles found on this page." };
  }

  // Process in two phases: first 15 for speed, then the rest
  const FIRST_BATCH = 15;
  let remainingTitles = null;
  if (titles.length > FIRST_BATCH) {
    console.debug(`[Unbait YT] Phase 1: ${FIRST_BATCH} of ${titles.length} titles`);
    remainingTitles = titles.slice(FIRST_BATCH);
    titles = titles.slice(0, FIRST_BATCH);
  }

  _ytElements.clear();
  _ytApplied.clear();

  const provider = await getCurrentProvider();
  const cache = await loadCache(provider);
  const { uncachedData, cachedCount } = categorizeHeadlines(titles, cache);

  if (uncachedData.length === 0) {
    return {
      success: true,
      found: titles.length,
      count: cachedCount,
      cached: true,
    };
  }

  // Enrich uncached titles with transcript context (limited concurrency)
  await enrichWithTranscripts(uncachedData);

  // Optionally replace thumbnails
  try {
    const settings = await chrome.storage.local.get("youtubeThumbnails");
    if (settings.youtubeThumbnails) {
      for (const item of titles) {
        const renderer = item.element.closest(
          "ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, " +
            "ytd-playlist-video-renderer, ytd-grid-video-renderer"
        );
        if (renderer) {
          replaceThumbnail(item.videoId, renderer);
        }
      }
    }
  } catch {
    // Thumbnail replacement is optional, ignore errors
  }

  const result = await fetchAndApplyResults(uncachedData, provider, cachedCount, titles.length);

  // Phase 2: process remaining titles in the background
  if (remainingTitles && remainingTitles.length > 0) {
    processRemainingTitles(remainingTitles, provider).catch(() => {});
  }

  // Start observing for new videos from infinite scroll
  startObserving();

  return result;
}

async function processRemainingTitles(titles, provider) {
  console.debug(`[Unbait YT] Phase 2: processing ${titles.length} remaining titles`);
  const cache = await loadCache(provider);
  const { uncachedData, cachedCount } = categorizeHeadlines(titles, cache);
  if (uncachedData.length === 0) return;
  await enrichWithTranscripts(uncachedData);
  await fetchAndApplyResults(uncachedData, provider, cachedCount, titles.length);
}

// ---------------------------------------------------------------------------
// MutationObserver for SPA navigation
// ---------------------------------------------------------------------------

let _ytObserver = null;
let _ytObserverDebounce = null;

function startObserving() {
  if (_ytObserver) return;

  _ytObserver = new MutationObserver((mutations) => {
    if (_ytObserverDebounce) clearTimeout(_ytObserverDebounce);
    _ytObserverDebounce = setTimeout(() => {
      if (_ytIsProcessing) return;

      // Only process if genuinely new video renderers appeared
      // (not our own DOM changes or YouTube re-rendering existing ones)
      const titles = findYouTubeTitles();
      const newTitles = titles.filter((t) => {
        // Skip if we already processed this video ID
        const vid = t.videoId;
        return vid && !_ytApplied.has(`yt-${vid}`) && !_ytElements.has(`yt-${vid}`);
      });

      if (newTitles.length === 0) return;

      console.debug(`[Unbait YT] ${newTitles.length} new titles from scroll`);
      _ytIsProcessing = true;
      processYouTubeTitles()
        .then(() => {
            _ytIsProcessing = false;
          })
          .catch(() => {
            _ytIsProcessing = false;
          });
      }
    }, YT_CONFIG.OBSERVER_DEBOUNCE_MS);
  });

  _ytObserver.observe(document.body, { childList: true, subtree: true });
  console.debug("[Unbait YT] MutationObserver started");
}

function stopObserving() {
  if (_ytObserver) {
    _ytObserver.disconnect();
    _ytObserver = null;
    if (_ytObserverDebounce) {
      clearTimeout(_ytObserverDebounce);
      _ytObserverDebounce = null;
    }
    console.debug("[Unbait YT] MutationObserver stopped");
  }
}

// Check if "Always On" includes youtube.com and start observer accordingly
async function checkAlwaysOn() {
  try {
    const data = await chrome.storage.local.get("alwaysOnSites");
    const sites = data.alwaysOnSites || [];
    const isYouTubeAlwaysOn = sites.some(
      (s) =>
        s === "youtube.com" ||
        s === "www.youtube.com" ||
        s === "*.youtube.com" ||
        window.location.hostname.endsWith(s)
    );
    if (isYouTubeAlwaysOn) {
      startObserving();
    } else {
      stopObserving();
    }
  } catch {
    // Ignore errors
  }
}

// Listen for storage changes to toggle observer
chrome.storage.onChanged.addListener((changes) => {
  if (changes.alwaysOnSites) {
    checkAlwaysOn();
  }
});

// Initial check
checkAlwaysOn();

} // end double-injection guard
