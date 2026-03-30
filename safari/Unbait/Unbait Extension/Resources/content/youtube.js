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
let _ytReplaceThumbnails = false;

// Gist summary state
let _gistEnabled = true;
let _gistClickMode = "summary"; // "summary" = single click shows gist, "title" = single click toggles title
let _gistActiveOverlay = null;
let _gistActiveUrl = null;
let _gistActiveIconEl = null;
let _gistPendingRequests = new Set();
let _gistCacheWriteQueue = Promise.resolve();
const _gistTranscriptSource = new Map(); // url -> "transcript" | "title-only"

chrome.storage.local.get(["gistEnabled", "gistClickMode"], (data) => {
  _gistEnabled = data.gistEnabled !== false;
  _gistClickMode = data.gistClickMode || "summary";
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const YT_CONFIG = {
  CACHE_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  CACHE_MAX_ENTRIES: 500,
  API_TIMEOUT_MS: 120000,
  TRANSCRIPT_CONCURRENCY: 3,
  TRANSCRIPT_BATCH_DELAY_MS: 500,
  TRANSCRIPT_TIMEOUT_MS: 5000,
  TRANSCRIPT_MAX_CHARS: 1000,
  TRANSCRIPT_MAX_TIME_MS: 120000, // first ~2 minutes of captions
  DESCRIPTION_MAX_CHARS: 500,
  MIN_TITLE_LENGTH: 5,
  OBSERVER_DEBOUNCE_MS: 400,
  SCROLL_AHEAD_PX: 1500, // pre-fetch titles this far below the viewport
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

  if (message.action === "gist-stream") {
    handleGistStream(message);
  }

  if (message.action === "gist-result") {
    handleGistResult(message);
  }

  if (message.action === "get-stats") {
    const replaced = document.querySelectorAll(".unbait-replaced").length;
    const icons = document.querySelectorAll(".unbait-icon").length;
    sendResponse({
      found: (replaced + icons) > 0 ? _ytElements.size || replaced : 0,
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
  _ytApplied.clear();
  if (!_ytIsProcessing) restoreCachedTitles();
});

// YouTube SPA navigation — fires when YouTube finishes loading a new "page"
window.addEventListener("yt-navigate-finish", () => {
  _ytApplied.clear();
  setTimeout(() => {
    if (!_ytIsProcessing) {
      restoreCachedTitles();
      chrome.storage.local.get(["youtubeEnabled", "alwaysOnSites"], (data) => {
        const alwaysOn = (data.alwaysOnSites || []).some(
          (s) => s === "youtube.com" || s === "www.youtube.com" || s === "*.youtube.com"
        );
        if ((data.youtubeEnabled || alwaysOn) && !_ytIsProcessing) {
          processYouTubeTitles();
        }
      });
    }
  }, 500);
});

// Backup: YouTube sometimes fires this instead
window.addEventListener("yt-page-data-updated", () => {
  _ytApplied.clear();
  setTimeout(() => {
    if (!_ytIsProcessing) restoreCachedTitles();
  }, 300);
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

    for (const [url, value] of Object.entries(entries)) {
      const newTitle = typeof value === "string" ? value : value.newTitle;
      const originalTitle = typeof value === "string" ? undefined : value.originalTitle;
      cache[url] = { newTitle, originalTitle, ts: now };
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
        // Use stored original title from cache — never trust el.textContent here
        // because it may already show our rewritten title from a prior restore call
        const originalTitle = cached.originalTitle || item.text;
        renderReplacedHeadline(item.element, cached.newTitle, originalTitle);
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
    if (!el.dataset.unbaitNew) return;
    // Remove existing icon — check inside el and the immediate next sibling
    el.querySelector(".unbait-icon")?.remove();
    if (el.nextElementSibling?.classList.contains("unbait-icon")) {
      el.nextElementSibling.remove();
    }

    const icon = document.createElement("span");
    icon.className = "unbait-icon";
    icon.title = "Click to show original";
    icon.setAttribute("role", "button");
    icon.setAttribute("tabindex", "0");
    icon.setAttribute("aria-label", "Toggle original headline");
    const currentText = (el.firstChild?.nodeType === Node.TEXT_NODE
      ? el.firstChild.textContent
      : el.textContent).trim();
    if (currentText === el.dataset.unbaitOriginal) {
      icon.classList.add("showing-original");
    }
    let _restoreClickTimer = null;
    icon.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!_gistEnabled) {
        toggleTitle(el, icon);
        return;
      }
      if (_restoreClickTimer) {
        clearTimeout(_restoreClickTimer);
        _restoreClickTimer = null;
        if (_gistClickMode === "title") {
          const videoId = el.dataset.unbaitVideoId || extractVideoId(el.closest("a")?.href);
          const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
          const title = el.dataset.unbaitOriginal || el.textContent.trim();
          if (url) handleGistYTClick(e, url, title, videoId, icon);
        } else {
          toggleTitle(el, icon);
        }
      } else {
        _restoreClickTimer = setTimeout(() => {
          _restoreClickTimer = null;
          if (_gistClickMode === "title") {
            toggleTitle(el, icon);
          } else {
            const videoId = el.dataset.unbaitVideoId || extractVideoId(el.closest("a")?.href);
            const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
            const title = el.dataset.unbaitOriginal || el.textContent.trim();
            if (url) handleGistYTClick(e, url, title, videoId, icon);
          }
        }, 250);
      }
    });
    icon.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        icon.click();
      }
    });
    el.parentNode?.insertBefore(icon, el.nextSibling);
  });
}

// ---------------------------------------------------------------------------
// Find YouTube video titles
// ---------------------------------------------------------------------------

const YT_TITLE_SELECTORS = [
  "ytd-rich-item-renderer h3",                   // Homepage grid (2026 layout)
  "ytd-rich-grid-media h3",                      // Homepage grid (alternate)
  "ytd-video-renderer h3",                       // Search results
  "ytd-compact-video-renderer h3",               // Sidebar suggestions (watch page)
  "ytd-compact-video-renderer #video-title",     // Sidebar suggestions (legacy)
  "ytd-playlist-video-renderer h3",              // Playlist
  "ytd-playlist-video-renderer #video-title",    // Playlist (legacy)
  "ytd-grid-video-renderer h3",                  // Channel page grid
  "ytd-reel-item-renderer h3",                   // Shorts shelf
  "ytd-watch-next-secondary-results-renderer h3", // Watch page recommendations container
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

// Fast path: works when on the video's own watch page (ytInitialPlayerResponse)
async function fetchTranscriptFromPage(videoId) {
  if (typeof window === "undefined" || !window.ytInitialPlayerResponse?.captions) return null;
  const pageVideoId = window.ytInitialPlayerResponse.videoDetails?.videoId;
  if (pageVideoId && pageVideoId !== videoId) return null;
  const tracks = window.ytInitialPlayerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) return null;
  const preferred = tracks.find((t) => t.languageCode === navigator.language.split("-")[0] && t.kind !== "asr")
    || tracks.find((t) => t.languageCode === "en" && t.kind !== "asr")
    || tracks.find((t) => t.languageCode === "en")
    || tracks[0];
  try {
    const captionResp = await fetch(preferred.baseUrl + "&fmt=json3", { credentials: "same-origin" });
    if (!captionResp.ok) return null;
    const captionData = await captionResp.json();
    return captionData.events || null;
  } catch { return null; }
}

// InnerTube ANDROID client — works from any YouTube page via content script.
// credentials: "include" sends the user's YouTube session cookies (critical for EU).
async function fetchTranscriptViaInnerTube(videoId) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const playerResp = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            // ANDROID client returns captions; WEB client returns 0 tracks
            clientName: "ANDROID",
            clientVersion: "20.10.38",
            androidSdkVersion: 30,
            hl: "en",
          },
        },
      }),
    });
    clearTimeout(timer);
    if (!playerResp.ok) return null;
    const playerData = await playerResp.json();
    const tracks = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) return null;
    const preferred = tracks.find((t) => t.languageCode === "en" && t.kind !== "asr")
      || tracks.find((t) => t.languageCode === "en")
      || tracks[0];
    // ANDROID client sets fmt=srv3 in baseUrl — replace with json3 (not append!)
    const captionUrl = new URL(preferred.baseUrl);
    captionUrl.searchParams.set("fmt", "json3");
    const captionResp = await fetch(captionUrl.toString(), { credentials: "include" });
    if (!captionResp.ok) return null;
    const captionData = await captionResp.json();
    return captionData.events || null;
  } catch { return null; }
}

// Fetch raw caption events for a video (tries fast path, then InnerTube)
async function fetchCaptionEvents(videoId) {
  let events = await fetchTranscriptFromPage(videoId);
  if (!events) events = await fetchTranscriptViaInnerTube(videoId);
  return events;
}

// Build transcript text for de-clickbait title rewriting (chars/time-based)
function buildTitleTranscript(events) {
  if (!events || events.length === 0) return null;
  let text = "";
  for (const ev of events) {
    if (ev.segs) text += ev.segs.map((s) => s.utf8).join("");
    if (ev.tStartMs && ev.tStartMs > YT_CONFIG.TRANSCRIPT_MAX_TIME_MS) break;
  }
  return text.replace(/\n/g, " ").trim().slice(0, YT_CONFIG.TRANSCRIPT_MAX_CHARS) || null;
}

// Build transcript text for gist summary (percentage-based with timestamps)
async function buildGistTranscript(events) {
  if (!events || events.length === 0) return null;
  const data = await chrome.storage.local.get("ytGistDepth");
  const depthPct = data.ytGistDepth || 50;
  const lastEv = events[events.length - 1];
  const totalMs = lastEv ? (lastEv.tStartMs || 0) + (lastEv.dDurationMs || 0) : 0;
  const cutoffMs = totalMs > 0 ? totalMs * (depthPct / 100) : Infinity;
  const maxChars = Math.round(1500 + (depthPct / 100) * 10500);

  let text = "";
  let lastStampMs = -30000;
  for (const ev of events) {
    if (ev.tStartMs != null && ev.tStartMs > cutoffMs) break;
    if (ev.segs) {
      if (ev.tStartMs != null && ev.tStartMs - lastStampMs >= 30000) {
        const min = Math.floor(ev.tStartMs / 60000);
        const sec = Math.floor((ev.tStartMs % 60000) / 1000).toString().padStart(2, "0");
        text += `[${min}:${sec}] `;
        lastStampMs = ev.tStartMs;
      }
      text += ev.segs.map((seg) => seg.utf8).join("");
    }
  }
  return text.replace(/\n/g, " ").trim().slice(0, maxChars) || null;
}

// Legacy wrapper for enrichWithTranscripts (de-clickbait flow)
async function fetchTranscript(videoId, signal) {
  try {
    const events = await fetchCaptionEvents(videoId);
    if (!events) {
      // Fallback: try page fetch for description
      const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: "omit", referrer: "", signal });
      if (!resp.ok) return null;
      const html = await resp.text();
      const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script)/s);
      if (!match) return null;
      const data = JSON.parse(match[1]);
      const desc = data?.videoDetails?.shortDescription;
      return desc ? desc.slice(0, YT_CONFIG.DESCRIPTION_MAX_CHARS) : null;
    }
    return buildTitleTranscript(events);
  } catch { return null; }
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
      const transcript = await fetchTranscript(item.videoId, controller.signal);
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
    // Delay between batches to avoid YouTube rate limiting
    if (i + YT_CONFIG.TRANSCRIPT_CONCURRENCY < titles.length) {
      await new Promise((r) => setTimeout(r, YT_CONFIG.TRANSCRIPT_BATCH_DELAY_MS));
    }
  }

  const withContext = titles.filter((t) => t.context).length;
  console.debug(
    `[Unbait YT] Transcripts: ${withContext}/${titles.length}`
  );
}

// ---------------------------------------------------------------------------
// Thumbnail replacement (optional, MVP: dim + grayscale)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Render / apply / toggle (self-contained, mirrors content.js)
// ---------------------------------------------------------------------------

// Set title text while preserving the <a> link inside the element.
// Direct el.textContent = X destroys child links, making titles unclickable.
function setTitleText(el, text) {
  if (el.tagName === "A") {
    el.textContent = text;
  } else {
    const link = el.querySelector("a");
    if (link) {
      link.textContent = text;
    } else {
      el.textContent = text;
    }
  }
}

function renderReplacedHeadline(el, newTitle, originalText) {
  el.classList.add("unbait-replaced");
  el.dataset.unbaitNew = newTitle;
  // Only set original once — never overwrite a valid stored original with
  // whatever the DOM currently shows (it may already be our rewritten title)
  if (originalText && originalText !== newTitle && !el.dataset.unbaitOriginal) {
    el.dataset.unbaitOriginal = originalText;
  }
  el.title = `Original: ${el.dataset.unbaitOriginal || originalText}`;

  // Mark the renderer container
  const renderer = el.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer");
  if (renderer) renderer.dataset.unbaitProcessed = "true";

  const icon = document.createElement("span");
  icon.className = "unbait-icon";
  icon.title = "Click to show original";
  icon.setAttribute("role", "button");
  icon.setAttribute("tabindex", "0");
  icon.setAttribute("aria-label", "Toggle original headline");
  let _iconClickTimer = null;
  icon.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!_gistEnabled) {
      toggleTitle(el, icon);
      return;
    }
    // Single/double click discrimination
    if (_iconClickTimer) {
      clearTimeout(_iconClickTimer);
      _iconClickTimer = null;
      // Double click
      if (_gistClickMode === "title") {
        const videoId = el.dataset.unbaitVideoId || extractVideoId(el.closest("a")?.href);
        const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
        const title = el.dataset.unbaitOriginal || el.textContent.trim();
        if (url) handleGistYTClick(e, url, title, videoId, icon);
      } else {
        toggleTitle(el, icon);
      }
    } else {
      _iconClickTimer = setTimeout(() => {
        _iconClickTimer = null;
        // Single click
        if (_gistClickMode === "title") {
          toggleTitle(el, icon);
        } else {
          const videoId = el.dataset.unbaitVideoId || extractVideoId(el.closest("a")?.href);
          const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
          const title = el.dataset.unbaitOriginal || el.textContent.trim();
          if (url) handleGistYTClick(e, url, title, videoId, icon);
        }
      }, 250);
    }
  });
  icon.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      icon.click();
    }
  });

  // Remove any existing icon before inserting the new one
  el.querySelector(".unbait-icon")?.remove();
  el.querySelector(".gist-icon")?.remove();
  if (el.nextElementSibling?.classList.contains("unbait-icon")) {
    el.nextElementSibling.remove();
  }
  if (el.nextElementSibling?.classList.contains("gist-icon")) {
    el.nextElementSibling.remove();
  }

  setTitleText(el, newTitle);
  // Place icon as sibling AFTER the title element — keeps it outside any
  // line-clamp container and avoids click interception inside <a> tags
  el.parentNode?.insertBefore(icon, el.nextSibling);
}

/**
 * Replace a clickbait thumbnail with a neutral video frame.
 * YouTube auto-generates frames at 25%/50%/75% of the video:
 * - 1.jpg = 25%, 2.jpg = 50%, 3.jpg = 75%
 * These are neutral frames, not the custom clickbait thumbnail.
 * Cost: 0 extra tokens — just a URL swap.
 */
function replaceThumbnail(el, videoId) {
  if (!_ytReplaceThumbnails || !videoId) return;

  const renderer = el.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer");
  if (!renderer) return;

  // Find the thumbnail image
  const thumbContainer = renderer.querySelector("ytd-thumbnail, .ytd-thumbnail, yt-thumbnail-view-model");
  if (!thumbContainer) return;

  const img = thumbContainer.querySelector("img");
  if (!img || img.classList.contains("unbait-thumb-replaced")) return;

  // Neutral frame URL (50% of the video)
  const neutralUrl = `https://i.ytimg.com/vi/${videoId}/2.jpg`;

  // Hide original img, insert new one
  img.style.display = "none";
  img.classList.add("unbait-thumb-original");

  const newImg = document.createElement("img");
  newImg.src = neutralUrl;
  newImg.className = "unbait-thumb-replaced";
  newImg.style.cssText = "width: 100%; height: 100%; object-fit: cover; border-radius: inherit;";
  newImg.alt = img.alt || "";
  newImg.loading = "lazy";

  img.parentNode.insertBefore(newImg, img);
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

  // Replace thumbnail if enabled (only for videos that were de-clickbaited)
  const videoId = el.dataset.unbaitVideoId;
  replaceThumbnail(el, videoId);

  return true;
}

function applyStreamResult(result) {
  if (applyResult(result)) {
    const el = _ytElements.get(result.id);
    if (el) {
      const videoId = el.dataset.unbaitVideoId;
      if (videoId && result.newTitle) {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        setCacheEntries({ [url]: { newTitle: result.newTitle, originalTitle: el.dataset.unbaitOriginal } });
      }
    }
  }
}

function toggleTitle(el, icon) {
  const original = el.dataset.unbaitOriginal;
  const rewritten = el.dataset.unbaitNew;
  if (!original || !rewritten) return;

  const isShowingOriginal = icon.classList.contains("showing-original");

  // Also toggle thumbnail if it was replaced
  const renderer = el.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer");
  const neutralThumb = renderer?.querySelector(".unbait-thumb-replaced");
  const originalThumb = renderer?.querySelector(".unbait-thumb-original");

  if (isShowingOriginal) {
    setTitleText(el, rewritten);
    if (neutralThumb) neutralThumb.style.display = "";
    if (originalThumb) originalThumb.style.display = "none";
    el.title = `Original: ${original}`;
    icon.title = "Click to show original";
    icon.classList.remove("showing-original");
  } else {
    setTitleText(el, original);
    if (neutralThumb) neutralThumb.style.display = "none";
    if (originalThumb) originalThumb.style.display = "";
    el.title = `Unbait: ${rewritten}`;
    icon.title = "Click to show Unbait title";
    icon.classList.add("showing-original");
  }
  // Keep icon as sibling after the title element
  el.parentNode?.insertBefore(icon, el.nextSibling);
}

// ---------------------------------------------------------------------------
// Gist: overlay, rendering, cache, click handler (YouTube)
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
    if (!currentP) { currentP = document.createElement("p"); container.appendChild(currentP); }
    else { currentP.appendChild(document.createElement("br")); }
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
  const knownSource = _gistTranscriptSource.get(url);
  gistUpdateFooter(footer, url, knownSource || null);
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
  const pad = 8; const ow = 380; const maxH = 450;
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

function gistUpdateFooter(footer, url, source) {
  footer.textContent = "";
  const domain = document.createElement("span");
  domain.textContent = "youtube.com";
  footer.appendChild(domain);
  if (source) {
    const sep = document.createElement("span");
    sep.textContent = " \u00b7 ";
    sep.style.opacity = "0.4";
    footer.appendChild(sep);
    const badge = document.createElement("span");
    badge.textContent = source === "transcript" ? "transcript" : "title only";
    badge.style.fontWeight = "500";
    badge.style.color = source === "transcript" ? "#0d9488" : "#f59e0b";
    footer.appendChild(badge);
  }
}

// Gist cache (YouTube)
async function getGistYTCache(url) {
  const data = await chrome.storage.local.get("provider");
  const provider = data.provider || "anthropic";
  const cacheKey = `gist_yt_cache_${provider}`;
  const cacheData = await chrome.storage.local.get(cacheKey);
  const cache = cacheData[cacheKey] || {};
  const entry = cache[url];
  if (entry && Date.now() - entry.ts < YT_CONFIG.CACHE_MAX_AGE_MS) return entry;
  return null;
}

function cacheGistYTEntry(url, summary, hasTranscript) {
  _gistCacheWriteQueue = _gistCacheWriteQueue.then(async () => {
    const data = await chrome.storage.local.get("provider");
    const provider = data.provider || "anthropic";
    const cacheKey = `gist_yt_cache_${provider}`;
    const cacheData = await chrome.storage.local.get(cacheKey);
    const cache = cacheData[cacheKey] || {};
    cache[url] = { summary, ts: Date.now(), hasTranscript };
    const keys = Object.keys(cache);
    if (keys.length > YT_CONFIG.CACHE_MAX_ENTRIES) {
      keys.sort((a, b) => cache[a].ts - cache[b].ts);
      for (let i = 0; i < keys.length - YT_CONFIG.CACHE_MAX_ENTRIES; i++) delete cache[keys[i]];
    }
    await chrome.storage.local.set({ [cacheKey]: cache });
  }).catch(() => {});
}

function handleGistStream(message) {
  if (message.url !== _gistActiveUrl || !_gistActiveOverlay) return;
  const body = _gistActiveOverlay.querySelector(".gist-overlay-body");
  if (body) gistRenderText(body, message.text);
}

function handleGistResult(message) {
  _gistPendingRequests.delete(message.url);
  const videoId = extractVideoId(message.url);
  if (videoId) {
    const source = message.hasTranscript ? "transcript" : "title-only";
    _gistTranscriptSource.set(message.url, source);
  }
  if (message.url !== _gistActiveUrl || !_gistActiveOverlay) {
    if (message.summary) cacheGistYTEntry(message.url, message.summary, message.hasTranscript);
    return;
  }
  const footer = _gistActiveOverlay.querySelector(".gist-overlay-footer");
  if (footer) gistUpdateFooter(footer, message.url, _gistTranscriptSource.get(message.url) || null);
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
    cacheGistYTEntry(message.url, message.summary, message.hasTranscript);
  }
}

async function handleGistYTClick(e, url, title, videoId, icon) {
  e.preventDefault();
  e.stopPropagation();

  if (_gistActiveUrl === url && _gistActiveOverlay) { gistCloseOverlay(); return; }

  gistShowOverlay(icon, url);

  // Check cache
  const cached = await getGistYTCache(url);
  if (cached) {
    const source = cached.hasTranscript === true ? "transcript"
      : cached.hasTranscript === false ? "title-only" : null;
    if (source) _gistTranscriptSource.set(url, source);
    if (_gistActiveOverlay && _gistActiveUrl === url) {
      const footer = _gistActiveOverlay.querySelector(".gist-overlay-footer");
      if (footer) gistUpdateFooter(footer, url, source);
      const body = _gistActiveOverlay.querySelector(".gist-overlay-body");
      if (body) gistRenderText(body, cached.summary);
    }
    return;
  }

  if (_gistPendingRequests.has(url)) return;
  _gistPendingRequests.add(url);

  // Fetch transcript via InnerTube (fast path, then ANDROID client)
  const events = await fetchCaptionEvents(videoId);
  let transcript = events ? await buildGistTranscript(events) : null;

  if (transcript) {
    _gistTranscriptSource.set(url, "transcript");
    if (_gistActiveOverlay && _gistActiveUrl === url) {
      const footer = _gistActiveOverlay.querySelector(".gist-overlay-footer");
      if (footer) gistUpdateFooter(footer, url, "transcript");
    }
  }

  chrome.runtime.sendMessage({
    action: "summarize-youtube",
    url, title, videoId,
    transcript: transcript || undefined,
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

/**
 * Inject G-icons on YouTube titles that don't have a U-icon.
 * Allows users to get a gist summary even for titles that weren't de-clickbaited.
 */
function injectYTGistIcons() {
  if (!_gistEnabled) return;
  const titles = findYouTubeTitles();
  for (const item of titles) {
    const el = item.element;
    // Skip if already has U-icon or G-icon
    if (el.querySelector(".unbait-icon") || el.querySelector(".gist-icon")) continue;
    if (el.nextElementSibling?.classList.contains("unbait-icon")) continue;
    if (el.nextElementSibling?.classList.contains("gist-icon")) continue;

    const gIcon = document.createElement("span");
    gIcon.className = "gist-icon";
    gIcon.title = "Get the gist";
    gIcon.setAttribute("role", "button");
    gIcon.setAttribute("tabindex", "0");
    gIcon.setAttribute("aria-label", "Show summary");
    gIcon.dataset.gistUrl = item.url;
    gIcon.dataset.gistTitle = item.text;
    gIcon.dataset.gistVideoId = item.videoId;
    gIcon.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleGistYTClick(e, item.url, item.text, item.videoId, gIcon);
    });
    // Place as sibling after title (same as U-icon placement)
    el.parentNode?.insertBefore(gIcon, el.nextSibling);
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
    // Only store original on first scan — re-scans would capture our rewritten title
    if (!item.element.dataset.unbaitOriginal) {
      item.element.dataset.unbaitOriginal = item.text;
    }
    item.element.dataset.unbaitVideoId = item.videoId;

    const cached = cache[item.url];
    if (cached && Date.now() - cached.ts < YT_CONFIG.CACHE_MAX_AGE_MS) {
      _ytApplied.add(id);
      if (cached.newTitle) {
        const originalTitle = cached.originalTitle || item.text;
        renderReplacedHeadline(item.element, cached.newTitle, originalTitle);
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
          newCacheEntries[headline.url] = { newTitle: result.newTitle, originalTitle: headline.text };
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
  // Read settings: thumbnails + transcript depth
  try {
    const stored = await chrome.storage.local.get(["youtubeThumbnails", "ytTranscriptDepth"]);
    _ytReplaceThumbnails = !!stored.youtubeThumbnails;
    const depth = stored.ytTranscriptDepth || 2;
    const depthMap = {
      1: { chars: 500, timeMs: 60000 },
      2: { chars: 1000, timeMs: 120000 },
      3: { chars: 2000, timeMs: 240000 },
      4: { chars: 4000, timeMs: 480000 },
    };
    const settings = depthMap[depth] || depthMap[2];
    YT_CONFIG.TRANSCRIPT_MAX_CHARS = settings.chars;
    YT_CONFIG.TRANSCRIPT_MAX_TIME_MS = settings.timeMs;
  } catch { _ytReplaceThumbnails = false; }

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

  // Inject G-icons immediately so users can get summaries while de-clickbait loads
  injectYTGistIcons();

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
          replaceThumbnail(renderer, item.videoId);
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

  // On watch pages, sidebar recommendations load asynchronously.
  // Re-scan after delays to catch them.
  if (window.location.pathname === "/watch") {
    const rescanSidebar = async (delayMs) => {
      await new Promise((r) => setTimeout(r, delayMs));
      if (_ytIsProcessing) return;
      const laterTitles = findYouTubeTitles();
      const newOnes = laterTitles.filter(
        (t) => !_ytApplied.has(`yt-${t.videoId}`) && !_ytElements.has(`yt-${t.videoId}`)
      );
      if (newOnes.length > 0) {
        console.debug(`[Unbait YT] Sidebar rescan: ${newOnes.length} new titles`);
        _ytIsProcessing = true;
        try {
          const cache2 = await loadCache(provider);
          const { uncachedData: unc2 } = categorizeHeadlines(newOnes, cache2);
          if (unc2.length > 0) {
            await enrichWithTranscripts(unc2);
            await fetchAndApplyResults(unc2, provider, 0, newOnes.length);
          }
        } finally {
          _ytIsProcessing = false;
        }
      }
    };
    rescanSidebar(2000).catch(() => {});
    rescanSidebar(5000).catch(() => {});
  }

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

  const processNewTitles = () => {
    if (_ytIsProcessing) return;

    const titles = findYouTubeTitles();
    const newTitles = titles.filter((t) => {
      const vid = t.videoId;
      return vid && !_ytApplied.has(`yt-${vid}`) && !_ytElements.has(`yt-${vid}`);
    });

    if (newTitles.length === 0) return;

    console.debug(`[Unbait YT] ${newTitles.length} new titles detected`);
    _ytIsProcessing = true;
    processYouTubeTitles()
      .then(() => { _ytIsProcessing = false; })
      .catch(() => { _ytIsProcessing = false; });
  };

  // MutationObserver for new DOM elements (YouTube SPA navigation)
  _ytObserver = new MutationObserver(() => {
    if (_ytObserverDebounce) clearTimeout(_ytObserverDebounce);
    _ytObserverDebounce = setTimeout(processNewTitles, YT_CONFIG.OBSERVER_DEBOUNCE_MS);
  });

  _ytObserver.observe(document.body, { childList: true, subtree: true });

  // Scroll listener to pre-fetch titles ahead of the viewport
  let _scrollDebounce = null;
  window.addEventListener("scroll", () => {
    if (_scrollDebounce) clearTimeout(_scrollDebounce);
    _scrollDebounce = setTimeout(processNewTitles, 300);
  }, { passive: true });

  console.debug("[Unbait YT] Observer + scroll listener started");
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
