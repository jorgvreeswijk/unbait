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

// iPadOS 13+ spoofs the User-Agent as "Macintosh", so UA string detection fails.
// maxTouchPoints > 0 is the reliable cross-device way: iOS/iPad = 5, Mac = 0.
// On iOS, content-script fetches are sandboxed (session cookies not shared),
// so InnerTube always returns 0 tracks. Skip it to avoid hundreds of wasted calls.
const IS_IOS = navigator.maxTouchPoints > 0;

// Module state — grouped for readability
const _state = {
  isProcessing: false,
  phase2Running: false,
  rewriteResolve: null,
  replaceThumbnails: false,
  elements: new Map(),
  applied: new Set(),
  observer: null,
  observerDebounce: null,
  scrollHandler: null,
};

// Gist state is managed by shared.js (window.Unbait)
const _gistTranscriptSource = new Map(); // url -> "transcript" | "title-only"

// ---------------------------------------------------------------------------
// Delegated click / keydown handlers for .unbait-icon and .gist-icon
// Replaces per-icon inline addEventListener calls (which accumulate on re-render).
// ---------------------------------------------------------------------------

const _iconClickTimers = new WeakMap();

document.addEventListener("click", (e) => {
  // G-icon click (gist summary, no de-clickbaited title)
  const gIcon = e.target.closest(".gist-icon");
  if (gIcon) {
    e.preventDefault();
    e.stopPropagation();
    const url = gIcon.dataset.gistUrl;
    const title = gIcon.dataset.gistTitle;
    const videoId = gIcon.dataset.gistVideoId;
    if (url && title && videoId) handleGistYTClick(e, url, title, videoId, gIcon);
    return;
  }

  const icon = e.target.closest(".unbait-icon");
  if (!icon) return;
  e.preventDefault();
  e.stopPropagation();

  // The title element is always the previous sibling of the icon
  const el = icon.previousElementSibling;
  if (!el || !el.dataset.unbaitOriginal) return;

  if (!Unbait.gistEnabled) {
    toggleTitle(el, icon);
    return;
  }

  const existingTimer = _iconClickTimers.get(icon);
  if (existingTimer) {
    clearTimeout(existingTimer);
    _iconClickTimers.delete(icon);
    // Double click
    if (Unbait.gistClickMode === "title") {
      const videoId = el.dataset.unbaitVideoId || extractVideoId(el.closest("a")?.href);
      const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
      const title = el.dataset.unbaitOriginal || el.textContent.trim();
      if (url) handleGistYTClick(e, url, title, videoId, icon);
    } else {
      toggleTitle(el, icon);
    }
  } else {
    const timer = setTimeout(() => {
      _iconClickTimers.delete(icon);
      // Single click
      if (Unbait.gistClickMode === "title") {
        toggleTitle(el, icon);
      } else {
        const videoId = el.dataset.unbaitVideoId || extractVideoId(el.closest("a")?.href);
        const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
        const title = el.dataset.unbaitOriginal || el.textContent.trim();
        if (url) handleGistYTClick(e, url, title, videoId, icon);
      }
    }, 250);
    _iconClickTimers.set(icon, timer);
  }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const icon = e.target.closest(".unbait-icon, .gist-icon");
  if (!icon) return;
  e.preventDefault();
  icon.click();
}, true);

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
    if (_state.isProcessing) {
      sendResponse({ error: "Already processing, please wait." });
      return true;
    }
    _state.isProcessing = true;
    processYouTubeTitles()
      .then((result) => {
        _state.isProcessing = false;
        sendResponse(result);
      })
      .catch((err) => {
        _state.isProcessing = false;
        sendResponse({ error: err.message });
      });
    return true; // async response
  }

  if (message.action === "yt-stream-result") {
    applyStreamResult(message.result);
  }

  if (message.action === "yt-rewrite-complete") {
    const result = message.result;
    if (result && result.results) {
      for (const r of result.results) {
        applyResult(r);
      }
    }
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

  if (message.action === "yt-ads-result") {
    handleSponsorResult(message);
  }

  if (message.action === "get-stats") {
    const replaced = document.querySelectorAll(".unbait-replaced").length;
    const icons = document.querySelectorAll(".unbait-icon").length;
    sendResponse({
      found: (replaced + icons) > 0 ? _state.elements.size || replaced : 0,
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
  _state.applied.clear();
  if (!_state.isProcessing) restoreCachedTitles();
});

// YouTube SPA navigation — fires when YouTube finishes loading a new "page"
window.addEventListener("yt-navigate-finish", () => {
  _state.applied.clear();
  setTimeout(() => initSponsorSkip(), 800);
  setTimeout(() => {
    if (!_state.isProcessing) {
      restoreCachedTitles();
      chrome.storage.local.get("autoSites", (data) => {
        const sites = data.autoSites || [];
        const ytFull = sites.some((s) => {
          const host = typeof s === "string" ? s : s.host;
          const mode = typeof s === "string" ? "full" : s.mode;
          return ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(host) && mode === "full";
        });
        if (ytFull && !_state.isProcessing) {
          _state.isProcessing = true;
          processYouTubeTitles()
            .then(() => { _state.isProcessing = false; })
            .catch(() => { _state.isProcessing = false; });
        }
      });
    }
  }, 500);
});

// Backup: YouTube sometimes fires this instead
window.addEventListener("yt-page-data-updated", () => {
  _state.applied.clear();
  setTimeout(() => {
    if (!_state.isProcessing) restoreCachedTitles();
  }, 300);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !_state.isProcessing) {
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
  if (!_state.isProcessing) restoreCachedTitles();
}, 200);

// Sponsor-skip self-init on load (watch pages only; gated by setting inside)
setTimeout(() => initSponsorSkip(), 800);

// Mobile YouTube (and any SPA nav that doesn't fire yt-navigate-finish) is
// caught by polling the URL. initSponsorSkip() dedupes by videoId, so calling
// it on every change is cheap.
let _sponsorLastHref = location.href;
setInterval(() => {
  if (location.href !== _sponsorLastHref) {
    _sponsorLastHref = location.href;
    setTimeout(() => initSponsorSkip(), 600);
  }
}, 1500);

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

// _state.elements and _state.applied declared above

// ---------------------------------------------------------------------------
// Cache helpers (using shared.js, YouTube-specific prefix)
// ---------------------------------------------------------------------------

const YT_CACHE_PREFIX = "unbait_yt_cache_";
const YT_GIST_CACHE_PREFIX = "gist_yt_cache_";
const YT_SPONSOR_CACHE_PREFIX = "yt_sponsor_cache_v2_";

function getCache(provider) {
  return Unbait.getCache(YT_CACHE_PREFIX, provider);
}

function setCacheEntries(entries, provider) {
  Unbait.setCacheEntries(entries, YT_CACHE_PREFIX, YT_CONFIG.CACHE_MAX_AGE_MS, YT_CONFIG.CACHE_MAX_ENTRIES, provider);
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

    const provider = await Unbait.getCurrentProvider();
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
    // Update badge with total unbaited on page (incl. cached)
    notifyBadgeCount();
  } catch {
    // Best-effort restore
  }
}

function notifyBadgeCount() {
  const count = document.querySelectorAll(".unbait-replaced").length;
  if (count > 0) {
    chrome.runtime.sendMessage({ action: "update-badge-count", count }).catch(() => {});
  }
}

function restoreIcons() {
  document.querySelectorAll(".unbait-replaced").forEach((el) => {
    if (!el.dataset.unbaitNew) return;
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
    // Click/keydown handling is done via delegated listeners at module top.
    el.parentNode?.insertBefore(icon, el.nextSibling);
  });
}

// ---------------------------------------------------------------------------
// Find YouTube video titles
// ---------------------------------------------------------------------------

// Renderer containers (desktop ytd-* and mobile ytm-*). Used for closest() lookups.
const YT_RENDERER_SELECTOR =
  "ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, " +
  "ytm-rich-item-renderer, ytm-video-with-context-renderer, ytm-compact-video-renderer, ytm-compact-autoplay-renderer, ytm-media-item, ytm-playlist-video-renderer, ytm-reel-item-renderer, ytm-shelf-renderer";

const YT_TITLE_SELECTORS = [
  // Desktop (ytd-*)
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
  // Mobile (ytm-*) — iOS Safari / m.youtube.com
  "ytm-rich-item-renderer h3",
  "ytm-video-with-context-renderer h3",
  "ytm-compact-video-renderer h4",
  "ytm-compact-autoplay-renderer h4",
  "ytm-media-item h4",
  "ytm-playlist-video-renderer h4",
  "h3.media-item-headline span",                 // Mobile compact title span
  "h4.compact-media-item-headline span",
  // Mobile Shorts (ytm-shorts-lockup-view-model) — iOS Safari
  "ytm-shorts-lockup-view-model h3",
  "ytm-shorts-lockup-view-model-v2 h3",
  ".shortsLockupViewModelHostOutsideMetadataTitle span",
  ".shortsLockupViewModelHostMetadataTitle span",
  'a[href*="/shorts/"] h3 span.yt-core-attributed-string',
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
        const container = el.closest(YT_RENDERER_SELECTOR);
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

// Circuit breaker for YouTube's anti-bot rate limiting (HTTP 429 → redirect to
// google.com/sorry CAPTCHA). When too many transcript fetches fire at once,
// YouTube flags the session and blocks ALL transcript requests. Once tripped we
// pause the bulk fetches for a cooldown so the session can recover instead of
// escalating into a full CAPTCHA wall.
let _ytRateLimitedUntil = 0;
function ytRateLimited() { return Date.now() < _ytRateLimitedUntil; }
function ytTripRateLimit(ms = 90000) {
  if (!ytRateLimited()) {
    console.debug(`[Unbait YT] YouTube rate-limit detected — pausing transcript fetches for ${ms / 1000}s`);
  }
  _ytRateLimitedUntil = Math.max(_ytRateLimitedUntil, Date.now() + ms);
}

// ---------------------------------------------------------------------------
// Main-world bridge client
//
// content/yt-main-bridge.js runs in the PAGE's world and fetches captions with
// the page's own cookies — the only context where YouTube reliably serves them
// (extension contexts on iOS get empty 200 bodies). The SW registers it with
// world: "MAIN"; if that fails we inject the same file via a <script src> tag.
// ---------------------------------------------------------------------------

let _bridgePromise = null;
let _bridgeFallbackTried = false;
const _bridgePending = new Map(); // requestId → { resolve, timer }

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.source !== "unbait-bridge") return;
  const pending = _bridgePending.get(data.requestId);
  if (!pending) return;
  _bridgePending.delete(data.requestId);
  clearTimeout(pending.timer);
  pending.resolve(data);
});

function bridgeSend(msg, timeoutMs) {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      _bridgePending.delete(requestId);
      resolve(null);
    }, timeoutMs);
    _bridgePending.set(requestId, { resolve, timer });
    window.postMessage({ source: "unbait-cs", requestId, ...msg }, location.origin);
  });
}

async function bridgePing(timeoutMs) {
  const pong = await bridgeSend({ type: "unbait-bridge-ping" }, timeoutMs);
  return !!pong;
}

function ensureBridge() {
  if (_bridgePromise) return _bridgePromise;
  _bridgePromise = (async () => {
    if (await bridgePing(400)) {
      console.debug("[Unbait YT] Bridge: pong (registered script)");
      return true;
    }
    // Fallback: inject the bridge as a page <script> tag (needs the
    // web_accessible_resources manifest entry). Used when the browser
    // doesn't support/allow world:"MAIN" registration (e.g. older iOS).
    if (!_bridgeFallbackTried) {
      _bridgeFallbackTried = true;
      try {
        const el = document.createElement("script");
        el.src = chrome.runtime.getURL("content/yt-main-bridge.js");
        el.addEventListener("load", () => el.remove());
        (document.head || document.documentElement).appendChild(el);
        console.debug("[Unbait YT] Bridge: injected fallback script tag");
      } catch (e) {
        console.debug("[Unbait YT] Bridge: fallback injection failed:", e.message);
      }
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (await bridgePing(200)) {
          console.debug("[Unbait YT] Bridge: pong (fallback tag)");
          return true;
        }
      }
    }
    console.debug("[Unbait YT] Bridge: unavailable, using legacy fetch paths");
    return false;
  })();
  return _bridgePromise;
}

// Fetch caption events via the main-world bridge. Returns events array or null.
async function fetchCaptionEventsViaBridge(videoId, { bypassRateLimit = false, timeoutMs = 10000 } = {}) {
  if (!bypassRateLimit && ytRateLimited()) return null;
  if (!(await ensureBridge())) return null;
  const result = await bridgeSend({ type: "unbait-transcript-request", videoId }, timeoutMs);
  if (!result) return null;
  if (!result.ok) {
    if (result.status === 429) ytTripRateLimit();
    console.debug("[Unbait YT] Bridge:", videoId, "→ no captions (status", result.status + ")");
    return null;
  }
  console.debug("[Unbait YT] Bridge:", videoId, "→", result.events.length, "events via", result.via);
  return result.events;
}

// Proxy a fetch through the service worker to bypass iOS Safari's content-script
// CORS sandbox, which silently returns text/html + empty body for YouTube API
// sub-resource requests. Returns the body text, or null on failure.
async function fetchBodyViaServiceWorker(url, credentials = "include") {
  try {
    const result = await chrome.runtime.sendMessage({ action: "proxy-fetch", url, credentials });
    const ct = result?.contentType || "";
    console.debug("[Unbait YT] SW proxy result:", url.slice(0, 80),
      "ok=" + result?.ok, "status=" + result?.status,
      "ct=" + ct, "len=" + (result?.body?.length ?? "null"),
      result?.error ? "err=" + result.error : "");
    if (!result || !result.ok) return null;
    if (!result.body || result.body.length === 0) return null;
    // Filter out HTML error/redirect pages — caption data is always XML or JSON
    if (ct.includes("text/html")) return null;
    return result.body;
  } catch (e) {
    console.debug("[Unbait YT] SW proxy sendMessage error:", e.message);
    return null;
  }
}

// Fast path: works when on the video's own watch page (ytInitialPlayerResponse)
async function fetchTranscriptFromPage(videoId) {
  if (typeof window === "undefined" || !window.ytInitialPlayerResponse?.captions) {
    console.debug("[Unbait YT] fetchFromPage: no ytInitialPlayerResponse.captions");
    return null;
  }
  const pageVideoId = window.ytInitialPlayerResponse.videoDetails?.videoId;
  if (pageVideoId && pageVideoId !== videoId) {
    console.debug("[Unbait YT] fetchFromPage: ID mismatch —", pageVideoId, "≠", videoId);
    return null;
  }
  const tracks = window.ytInitialPlayerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) {
    console.debug("[Unbait YT] fetchFromPage: no caption tracks");
    return null;
  }
  const preferred = tracks.find((t) => t.languageCode === navigator.language.split("-")[0] && t.kind !== "asr")
    || tracks.find((t) => t.languageCode === "en" && t.kind !== "asr")
    || tracks.find((t) => t.languageCode === "en")
    || tracks[0];
  console.debug("[Unbait YT] fetchFromPage: fetching caption track", preferred.languageCode, preferred.kind);
  try {
    const captionResp = await fetch(preferred.baseUrl + "&fmt=json3", { credentials: "same-origin" });
    console.debug("[Unbait YT] fetchFromPage: status", captionResp.status);
    if (captionResp.status === 429) { ytTripRateLimit(); return null; }
    if (!captionResp.ok) return null;
    const captionData = await captionResp.json();
    return captionData.events || null;
  } catch (e) {
    console.debug("[Unbait YT] fetchFromPage: error —", e.message);
    return null;
  }
}

// InnerTube ANDROID client — works from any YouTube page via content script.
// credentials: "include" sends the user's YouTube session cookies (critical for EU).
// bypassRateLimit: true for single targeted requests (sponsor detection) that
// should not be gated by the bulk-enrichment circuit breaker.
async function fetchTranscriptViaInnerTube(videoId, bypassRateLimit = false) {
  if (!bypassRateLimit && ytRateLimited()) {
    console.debug("[Unbait YT] InnerTube: breaker open, skip", videoId);
    return null;
  }
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
            // TVHTML5_SIMPLY_EMBEDDED_PLAYER doesn't require po_token (unlike
            // ANDROID which YouTube restricted in 2024/2025 from browser contexts)
            clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
            clientVersion: "2.0",
          },
        },
      }),
    });
    clearTimeout(timer);
    console.debug("[Unbait YT] InnerTube:", videoId, "→ status", playerResp.status);
    if (playerResp.status === 429) { ytTripRateLimit(); return null; }
    if (!playerResp.ok) return null;
    const playerData = await playerResp.json();
    const tracks = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    console.debug("[Unbait YT] InnerTube:", videoId, "→ tracks", tracks?.length ?? 0);
    if (!tracks || tracks.length === 0) return null;
    const preferred = tracks.find((t) => t.languageCode === "en" && t.kind !== "asr")
      || tracks.find((t) => t.languageCode === "en")
      || tracks[0];
    // ANDROID client sets fmt=srv3 in baseUrl — replace with json3 (not append!)
    const captionUrl = new URL(preferred.baseUrl);
    captionUrl.searchParams.set("fmt", "json3");
    const captionResp = await fetch(captionUrl.toString(), { credentials: "include" });
    console.debug("[Unbait YT] InnerTube:", videoId, "→ caption status", captionResp.status);
    if (captionResp.status === 429) { ytTripRateLimit(); return null; }
    if (!captionResp.ok) return null;
    const captionData = await captionResp.json();
    console.debug("[Unbait YT] InnerTube:", videoId, "→ events", captionData.events?.length ?? 0);
    return captionData.events || null;
  } catch (e) {
    console.debug("[Unbait YT] InnerTube:", videoId, "→ exception:", e.message);
    return null;
  }
}

// Fetch raw caption events for a video: main-world bridge first (page-context
// cookies — the only path that works on iOS), then legacy fallbacks.
// On iOS, InnerTube always returns 0 tracks (sandbox cookie isolation) so skip it.
async function fetchCaptionEvents(videoId) {
  let events = await fetchCaptionEventsViaBridge(videoId);
  if (!events) events = await fetchTranscriptFromPage(videoId);
  if (!events && !IS_IOS) events = await fetchTranscriptViaInnerTube(videoId);
  return events;
}

// Parse YouTube's timedtext XML format into the same events array that json3 returns.
// iOS content-script fetches can't send page session cookies, so YouTube serves XML
// (its default unauthenticated timedtext format) instead of json3.
function parseXmlCaptionsToEvents(xmlText) {
  if (!xmlText || !xmlText.includes("<text")) return null;
  try {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const nodes = doc.querySelectorAll("text");
    const events = [];
    for (const node of nodes) {
      const start = parseFloat(node.getAttribute("start") || "0");
      const dur = parseFloat(node.getAttribute("dur") || "0");
      const content = node.textContent || "";
      if (content.trim()) {
        events.push({
          tStartMs: Math.round(start * 1000),
          dDurationMs: Math.round(dur * 1000),
          segs: [{ utf8: content }],
        });
      }
    }
    return events.length > 0 ? events : null;
  } catch { return null; }
}

// Decode a fetch Response as caption events: JSON (fmt=json3) first, then XML fallback.
async function parseCaptionBody(resp, label) {
  const ct = resp.headers.get("content-type") || "";
  const cl = resp.headers.get("content-length") || "?";
  console.debug(`[Unbait YT] ${label}: ct=${ct} cl=${cl}`);
  const text = await resp.text();
  console.debug(`[Unbait YT] ${label}: body[0:60]`, text.slice(0, 60));
  try {
    const data = JSON.parse(text);
    const events = data.events || null;
    console.debug(`[Unbait YT] ${label}: events (json)`, events?.length ?? 0);
    return events;
  } catch { /* fall through to XML */ }
  const events = parseXmlCaptionsToEvents(text);
  console.debug(`[Unbait YT] ${label}: events (xml)`, events?.length ?? 0);
  return events;
}

// Read ytInitialPlayerResponse from inline <script> tags in the DOM.
// The DOM textContent IS accessible from the isolated world even though
// window.ytInitialPlayerResponse (the live JS variable) is not. Works for
// fresh page loads; YouTube also injects a new script tag on SPA navigation.
async function fetchCaptionEventsFromDOM(videoId) {
  try {
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent || "";
      if (!text.includes('"captionTracks"')) continue;
      const idx = text.indexOf("ytInitialPlayerResponse");
      if (idx === -1) continue;
      const brace = text.indexOf("{", idx);
      if (brace === -1) continue;
      // Walk brackets to extract the full JSON object
      let depth = 0, end = brace;
      for (; end < text.length; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}") { if (--depth === 0) break; }
      }
      let ipr;
      try { ipr = JSON.parse(text.slice(brace, end + 1)); } catch { continue; }
      if (ipr?.videoDetails?.videoId !== videoId) continue;
      const tracks = ipr.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      console.debug("[Unbait YT] DOM parse: tracks", tracks?.length ?? 0, "for", videoId);
      if (!tracks?.length) return null;
      const preferred = tracks.find((t) => t.kind !== "asr") || tracks[0];
      // Route through SW to bypass iOS content-script CORS sandbox
      const captionUrl = preferred.baseUrl + "&fmt=json3";
      const swBody = await fetchBodyViaServiceWorker(captionUrl);
      if (swBody) {
        try { const d = JSON.parse(swBody); if (d.events?.length > 0) return d.events; } catch {}
        const xmlEvs = parseXmlCaptionsToEvents(swBody);
        if (xmlEvs?.length > 0) return xmlEvs;
      }
      // Fallback: direct fetch (works on Mac where content script has cookie access)
      const capResp = await fetch(captionUrl, { credentials: "include" });
      if (!capResp.ok) return null;
      const events = await parseCaptionBody(capResp, "DOM parse");
      return events;
    }
  } catch { return null; }
  return null;
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
  const depthPct = data.ytGistDepth || 100;
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
// NOTE: no HTML page-fetch fallback here — concurrent page fetches for 80+
// sidebar titles cause YouTube 429s and bot-detection. If InnerTube fails
// (e.g. on iOS where content-script fetches lack session cookies) we return
// null rather than flooding the page with watch-page requests.
async function fetchTranscript(videoId, signal) {
  try {
    const events = await fetchCaptionEvents(videoId);
    return events ? buildTitleTranscript(events) : null;
  } catch {
    return null;
  }
}

// Fetch caption events by downloading the watch-page HTML and parsing
// ytInitialPlayerResponse out of it. Used ONLY for sponsor detection (one
// request per current video), never for bulk sidebar-title enrichment.
async function fetchCaptionEventsFromWatchPage(videoId) {
  if (ytRateLimited()) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      credentials: "include",
      headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": navigator.language || "en" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    console.debug("[Unbait YT] Page fetch: status", resp.status, "for", videoId);
    if (resp.status === 429 || (resp.redirected && /\/sorry\b/.test(resp.url))) { ytTripRateLimit(); return null; }
    if (!resp.ok) return null;
    const html = await resp.text();

    // Locate ytInitialPlayerResponse in the HTML and extract it with
    // string-aware bracket counting so embedded } in string values don't
    // confuse the depth tracker.
    const marker = "ytInitialPlayerResponse";
    let idx = html.indexOf(marker);
    if (idx === -1) return null;
    idx = html.indexOf("{", idx);
    if (idx === -1) return null;
    let depth = 0, inStr = false, escape = false, end = idx;
    for (; end < html.length; end++) {
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (html[end] === "\\") escape = true;
        else if (html[end] === '"') inStr = false;
        continue;
      }
      if (html[end] === '"') { inStr = true; continue; }
      if (html[end] === "{") depth++;
      else if (html[end] === "}") { if (--depth === 0) break; }
    }
    let ipr;
    try { ipr = JSON.parse(html.slice(idx, end + 1)); } catch { return null; }
    if (ipr?.videoDetails?.videoId !== videoId) return null;

    const tracks = ipr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    console.debug("[Unbait YT] Page fetch: tracks", tracks?.length ?? 0, "for", videoId);
    if (!tracks?.length) return null;
    const preferred = tracks.find((t) => t.languageCode === "en" && t.kind !== "asr")
      || tracks.find((t) => t.languageCode === "en")
      || tracks[0];
    const captionUrl = preferred.baseUrl + "&fmt=json3";
    // Route through SW first to bypass iOS content-script CORS restrictions
    const swBody = await fetchBodyViaServiceWorker(captionUrl, "include");
    if (swBody) {
      try { const d = JSON.parse(swBody); if (d.events?.length > 0) return d.events; } catch {}
      const xmlEvs = parseXmlCaptionsToEvents(swBody);
      if (xmlEvs?.length > 0) return xmlEvs;
    }
    // Fallback: direct fetch (works on Mac where content scripts have cookie access)
    const capResp = await fetch(captionUrl, { credentials: "include" });
    console.debug("[Unbait YT] Page fetch: caption status", capResp.status);
    if (capResp.status === 429) { ytTripRateLimit(); return null; }
    if (!capResp.ok) return null;
    return await parseCaptionBody(capResp, "Page fetch (direct)");
  } catch (e) {
    console.debug("[Unbait YT] Page fetch: exception:", e.message);
    // "Load failed" = Safari CORS-blocked the 429→google.com/sorry redirect.
    // Trip the breaker so we don't hammer YouTube again for the next video.
    if (e.message && (e.message.includes("Load failed") || e.message.includes("load failed"))) {
      ytTripRateLimit(300000); // 5 min — CORS-blocked 429 means server-level block
    }
    return null;
  }
}

// Lightweight alternative: fetch captions via YouTube's public timedtext API.
// Two-step: (1) get the track list (detects video language), (2) fetch that language.
// Routes all requests through the SW to bypass iOS content-script CORS restrictions.
async function fetchCaptionEventsFromTimedtext(videoId) {
  if (ytRateLimited()) return null;
  try {
    // Step 1: get list of available caption tracks via SW proxy
    const listXml = await fetchBodyViaServiceWorker(
      `https://www.youtube.com/api/timedtext?type=list&v=${videoId}`,
      "include"
    );
    console.debug("[Unbait YT] timedtext list (SW):", (listXml || "").slice(0, 300));
    if (!listXml || !listXml.includes("<track")) return null;

    // Extract lang_code values; prefer English, else use first available
    const langCodes = [...listXml.matchAll(/lang_code="([^"]+)"/g)].map((m) => m[1]);
    if (!langCodes.length) return null;
    const lang = langCodes.find((l) => l === "en" || l.startsWith("en-")) || langCodes[0];
    console.debug("[Unbait YT] timedtext: lang", lang, "available:", langCodes);

    // Step 2: fetch captions in the detected language (manual first, then ASR)
    for (const kind of ["", "&kind=asr"]) {
      const body = await fetchBodyViaServiceWorker(
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kind}&fmt=json3`,
        "include"
      );
      if (!body) continue;
      try { const d = JSON.parse(body); if (d.events?.length > 10) return d.events; } catch {}
      const xmlEvs = parseXmlCaptionsToEvents(body);
      if (xmlEvs && xmlEvs.length > 10) return xmlEvs;
    }
    return null;
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
  const renderer = el.closest(YT_RENDERER_SELECTOR);
  if (renderer) renderer.dataset.unbaitProcessed = "true";

  const icon = document.createElement("span");
  icon.className = "unbait-icon";
  icon.title = "Click to show original";
  icon.setAttribute("role", "button");
  icon.setAttribute("tabindex", "0");
  icon.setAttribute("aria-label", "Toggle original headline");
  // Click/keydown handling is done via delegated listeners at module top.

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
  if (!_state.replaceThumbnails || !videoId) return;

  const renderer = el.closest(YT_RENDERER_SELECTOR);
  if (!renderer) return;

  // Find the thumbnail image
  const thumbContainer = renderer.querySelector("ytd-thumbnail, .ytd-thumbnail, yt-thumbnail-view-model, ytm-thumbnail-overlay, .thumbnail-container, .compact-media-item-image");
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
  if (_state.applied.has(result.id)) return false;
  _state.applied.add(result.id);

  const el = _state.elements.get(result.id);
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
    const el = _state.elements.get(result.id);
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
  const renderer = el.closest(YT_RENDERER_SELECTOR);
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
// Gist: YouTube-specific overlay and cache (uses shared.js for core overlay)
// ---------------------------------------------------------------------------

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
    badge.className = source === "transcript" ? "gist-source-transcript" : "gist-source-title";
    footer.appendChild(badge);
  }
}

// Gist cache (YouTube) — delegates to shared.js
function getGistYTCache(url) {
  return Unbait.getGistCache(url, YT_GIST_CACHE_PREFIX);
}

function cacheGistYTEntry(url, summary, hasTranscript) {
  Unbait.cacheGistEntry(url, summary, YT_GIST_CACHE_PREFIX, YT_CONFIG.CACHE_MAX_ENTRIES, { hasTranscript });
}

function handleGistStream(message) {
  if (message.url !== Unbait.gistActiveUrl || !Unbait.gistActiveOverlay) return;
  const body = Unbait.gistActiveOverlay.querySelector(".gist-overlay-body");
  if (body) Unbait.gistRenderText(body, message.text);
}

function handleGistResult(message) {
  Unbait.gistPendingRequests.delete(message.url);
  const videoId = extractVideoId(message.url);
  if (videoId) {
    const source = message.hasTranscript ? "transcript" : "title-only";
    _gistTranscriptSource.set(message.url, source);
  }
  if (message.url !== Unbait.gistActiveUrl || !Unbait.gistActiveOverlay) {
    if (message.summary) cacheGistYTEntry(message.url, message.summary, message.hasTranscript);
    return;
  }
  const footer = Unbait.gistActiveOverlay.querySelector(".gist-overlay-footer");
  if (footer) gistUpdateFooter(footer, message.url, _gistTranscriptSource.get(message.url) || null);
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
    cacheGistYTEntry(message.url, message.summary, message.hasTranscript);
  }
}

async function handleGistYTClick(e, url, title, videoId, icon) {
  e.preventDefault();
  e.stopPropagation();

  if (Unbait.gistActiveUrl === url && Unbait.gistActiveOverlay) { Unbait.gistCloseOverlay(); return; }

  // YouTube-specific footer renderer that shows transcript source badge
  const footerRenderer = (footer, u) => {
    const knownSource = _gistTranscriptSource.get(u);
    gistUpdateFooter(footer, u, knownSource || null);
  };
  Unbait.gistShowOverlay(icon, url, footerRenderer);

  // Check cache
  const cached = await getGistYTCache(url);
  if (cached) {
    const source = cached.hasTranscript === true ? "transcript"
      : cached.hasTranscript === false ? "title-only" : null;
    if (source) _gistTranscriptSource.set(url, source);
    if (Unbait.gistActiveOverlay && Unbait.gistActiveUrl === url) {
      const footer = Unbait.gistActiveOverlay.querySelector(".gist-overlay-footer");
      if (footer) gistUpdateFooter(footer, url, source);
      const body = Unbait.gistActiveOverlay.querySelector(".gist-overlay-body");
      if (body) Unbait.gistRenderText(body, cached.summary);
    }
    return;
  }

  if (Unbait.gistPendingRequests.has(url)) return;
  Unbait.gistPendingRequests.add(url);

  // Fetch transcript via InnerTube (fast path, then ANDROID client)
  const events = await fetchCaptionEvents(videoId);
  let transcript = events ? await buildGistTranscript(events) : null;

  if (transcript) {
    _gistTranscriptSource.set(url, "transcript");
    if (Unbait.gistActiveOverlay && Unbait.gistActiveUrl === url) {
      const footer = Unbait.gistActiveOverlay.querySelector(".gist-overlay-footer");
      if (footer) gistUpdateFooter(footer, url, "transcript");
    }
  }

  chrome.runtime.sendMessage({
    action: "summarize-youtube",
    url, title, videoId,
    transcript: transcript || undefined,
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

/**
 * Inject G-icons on YouTube titles that don't have a U-icon.
 * Allows users to get a gist summary even for titles that weren't de-clickbaited.
 */
function injectYTGistIcons() {
  if (!Unbait.gistEnabled) return;
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
    // Click/keydown handling is done via delegated listeners at module top.
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
    _state.elements.set(id, item.element);
    // Only store original on first scan — re-scans would capture our rewritten title
    if (!item.element.dataset.unbaitOriginal) {
      item.element.dataset.unbaitOriginal = item.text;
    }
    item.element.dataset.unbaitVideoId = item.videoId;

    const cached = cache[item.url];
    if (cached && Date.now() - cached.ts < YT_CONFIG.CACHE_MAX_AGE_MS) {
      _state.applied.add(id);
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
      _state.rewriteResolve = resolve;
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
      _state.rewriteResolve = null;
      throw e;
    }

    if (response && response.accepted) {
      const result = await Promise.race([
        completePromise,
        new Promise((resolve) =>
          setTimeout(() => {
            _state.rewriteResolve = null;
            resolve({
              success: true,
              found: totalFound,
              count: _state.applied.size,
            });
          }, YT_CONFIG.API_TIMEOUT_MS)
        ),
      ]);
      _state.elements.forEach((el) => el.classList.remove("unbait-loading"));
      return result;
    }

    // Legacy path: full response returned directly
    _state.rewriteResolve = null;

    if (!response) {
      _state.elements.forEach((el) => el.classList.remove("unbait-loading"));
      return { success: true, found: totalFound, count: _state.applied.size };
    }

    if (response.error) {
      _state.elements.forEach((el) => el.classList.remove("unbait-loading"));
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

    _state.elements.forEach((el) => el.classList.remove("unbait-loading"));

    let totalReplaced = 0;
    _state.elements.forEach((el) => {
      if (el.classList.contains("unbait-replaced")) totalReplaced++;
    });

    return { success: true, found: totalFound, count: totalReplaced };
  } catch (err) {
    _state.elements.forEach((el) => el.classList.remove("unbait-loading"));
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
    _state.replaceThumbnails = !!stored.youtubeThumbnails;
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
  } catch { _state.replaceThumbnails = false; }

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

  _state.elements.clear();
  _state.applied.clear();

  const provider = await Unbait.getCurrentProvider();
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

  // Enrich uncached titles with transcript context (limited concurrency).
  // On watch pages, fire sponsor detection first and wait 3 s before starting
  // the InnerTube flood — sponsor transcript fetch is the first call and needs
  // to succeed before rate-limiting kicks in from the bulk requests.
  if (window.location.pathname === "/watch") {
    initSponsorSkip();
    console.debug("[Unbait YT] Watch page: holding enrichment 3s for sponsor transcript");
    await new Promise((r) => setTimeout(r, 3000));
    console.debug("[Unbait YT] Watch page: 3s wait done, starting bulk enrichment");
  }
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
      if (_state.isProcessing) return;
      const laterTitles = findYouTubeTitles();
      const newOnes = laterTitles.filter(
        (t) => !_state.applied.has(`yt-${t.videoId}`) && !_state.elements.has(`yt-${t.videoId}`)
      );
      // Re-inject G-icons for any new titles found in rescan
      injectYTGistIcons();
      if (newOnes.length > 0) {
        console.debug(`[Unbait YT] Sidebar rescan: ${newOnes.length} new titles`);
        _state.isProcessing = true;
        try {
          const cache2 = await loadCache(provider);
          const { uncachedData: unc2 } = categorizeHeadlines(newOnes, cache2);
          if (unc2.length > 0) {
            await enrichWithTranscripts(unc2);
            await fetchAndApplyResults(unc2, provider, 0, newOnes.length);
          }
        } finally {
          _state.isProcessing = false;
        }
      }
    };
    rescanSidebar(2000).catch(() => {});
    rescanSidebar(5000).catch(() => {});
  }

  return result;
}

async function processRemainingTitles(titles, provider) {
  if (_state.phase2Running) {
    console.debug("[Unbait YT] Phase 2: already running, skip");
    return;
  }
  _state.phase2Running = true;
  try {
    console.debug(`[Unbait YT] Phase 2: processing ${titles.length} remaining titles`);
    const cache = await loadCache(provider);
    const { uncachedData, cachedCount } = categorizeHeadlines(titles, cache);
    if (uncachedData.length === 0) return;
    await enrichWithTranscripts(uncachedData);
    await fetchAndApplyResults(uncachedData, provider, cachedCount, titles.length);
  } finally {
    _state.phase2Running = false;
  }
}

// ---------------------------------------------------------------------------
// MutationObserver for SPA navigation
// ---------------------------------------------------------------------------

// _state.observer, _state.observerDebounce, _state.scrollHandler declared above

function startObserving() {
  if (_state.observer) return;

  const processNewTitles = () => {
    if (_state.isProcessing) return;

    const titles = findYouTubeTitles();
    const newTitles = titles.filter((t) => {
      const vid = t.videoId;
      return vid && !_state.applied.has(`yt-${vid}`) && !_state.elements.has(`yt-${vid}`);
    });

    if (newTitles.length === 0) return;

    console.debug(`[Unbait YT] ${newTitles.length} new titles detected`);
    _state.isProcessing = true;
    processYouTubeTitles()
      .then(() => { _state.isProcessing = false; })
      .catch(() => { _state.isProcessing = false; });
  };

  // MutationObserver for new DOM elements (YouTube SPA navigation)
  _state.observer = new MutationObserver(() => {
    if (_state.observerDebounce) clearTimeout(_state.observerDebounce);
    _state.observerDebounce = setTimeout(processNewTitles, YT_CONFIG.OBSERVER_DEBOUNCE_MS);
  });

  _state.observer.observe(document.body, { childList: true, subtree: true });

  // Scroll listener to pre-fetch titles ahead of the viewport
  let _scrollDebounce = null;
  _state.scrollHandler = () => {
    if (_scrollDebounce) clearTimeout(_scrollDebounce);
    _scrollDebounce = setTimeout(processNewTitles, 300);
  };
  window.addEventListener("scroll", _state.scrollHandler, { passive: true });

  console.debug("[Unbait YT] Observer + scroll listener started");
}

function stopObserving() {
  if (_state.observer) {
    _state.observer.disconnect();
    _state.observer = null;
    if (_state.observerDebounce) {
      clearTimeout(_state.observerDebounce);
      _state.observerDebounce = null;
    }
    if (_state.scrollHandler) {
      window.removeEventListener("scroll", _state.scrollHandler);
      _state.scrollHandler = null;
    }
    console.debug("[Unbait YT] MutationObserver + scroll listener stopped");
  }
}

// Check if "Always On" includes youtube.com and start observer accordingly
async function checkAlwaysOn() {
  try {
    const data = await chrome.storage.local.get("autoSites");
    const sites = data.autoSites || [];
    const isYouTubeAlwaysOn = sites.some((s) => {
      const host = typeof s === "string" ? s : s.host;
      const mode = typeof s === "string" ? "full" : s.mode;
      if (mode !== "full") return false;
      return ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(host);
    });
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
  if (changes.autoSites) {
    checkAlwaysOn();
  }
});

// Initial check
checkAlwaysOn();

// ---------------------------------------------------------------------------
// In-video sponsor / self-promo skip
// Detects creator-read ad segments (not blocked by YouTube Premium) from the
// timestamped transcript and lets the viewer skip them — via a button by
// default, or fully automatically when ytSponsorAuto is on.
// ---------------------------------------------------------------------------

const _sponsor = {
  videoId: null,
  url: null,
  segments: [],
  auto: false,
  video: null,
  timeupdateHandler: null,
  button: null,
  activeSegment: null,
  pending: false,
  retryTimer: null,
};

const SPONSOR_SKIP_PAD_S = 0.3; // stop a touch before the detected end
// Mobile YouTube (m.youtube.com) has a different player DOM than desktop:
// no #movie_player / .html5-video-player / .ytp-progress-bar. We render the
// skip button as a fixed viewport overlay there instead of inside the player.
const IS_YT_MOBILE = location.hostname === "m.youtube.com";

// Build a densely-timestamped transcript (a [m:ss] marker roughly every ~12s)
// so the LLM can pin segment boundaries precisely. Whole video, capped.
function buildSponsorTranscript(events) {
  if (!events || events.length === 0) return null;
  const MAX_CHARS = 16000;
  const STAMP_EVERY_MS = 12000;
  let text = "";
  let lastStampMs = -STAMP_EVERY_MS;
  for (const ev of events) {
    if (!ev.segs) continue;
    if (ev.tStartMs != null && ev.tStartMs - lastStampMs >= STAMP_EVERY_MS) {
      const min = Math.floor(ev.tStartMs / 60000);
      const sec = Math.floor((ev.tStartMs % 60000) / 1000).toString().padStart(2, "0");
      text += `[${min}:${sec}] `;
      lastStampMs = ev.tStartMs;
    }
    text += ev.segs.map((s) => s.utf8).join("");
  }
  return text.replace(/\n/g, " ").trim().slice(0, MAX_CHARS) || null;
}

function getSponsorYTCache(url) {
  return Unbait.getGistCache(url, YT_SPONSOR_CACHE_PREFIX);
}

function cacheSponsorYTEntry(url, segments) {
  // Reuse the gist cache shape; segments ride along as an extra field.
  Unbait.cacheGistEntry(url, "", YT_SPONSOR_CACHE_PREFIX, YT_CONFIG.CACHE_MAX_ENTRIES, { segments });
}

// Tear down any active listeners/UI (called on SPA navigation away).
function resetSponsorSkip() {
  if (_sponsor.video && _sponsor.timeupdateHandler) {
    _sponsor.video.removeEventListener("timeupdate", _sponsor.timeupdateHandler);
  }
  hideSponsorButton();
  document.querySelectorAll(".ytp-progress-bar .unbait-sponsor-marker").forEach((m) => m.remove());
  if (_sponsor.retryTimer) { clearTimeout(_sponsor.retryTimer); _sponsor.retryTimer = null; }
  _sponsor.videoId = null;
  _sponsor.url = null;
  _sponsor.segments = [];
  _sponsor.video = null;
  _sponsor.timeupdateHandler = null;
  _sponsor.activeSegment = null;
  _sponsor.pending = false;
}

async function initSponsorSkip() {
  try {
    // Left a watch page → tear down any leftover UI.
    if (window.location.pathname !== "/watch") { resetSponsorSkip(); return; }

    const data = await chrome.storage.local.get(["ytSponsorSkip", "ytSponsorAuto"]);
    if (data.ytSponsorSkip === false) { resetSponsorSkip(); return; } // default on
    _sponsor.auto = !!data.ytSponsorAuto;

    const videoId = extractVideoId(window.location.href);
    if (!videoId) return;
    // Same video we're already handling → nothing to do (dedupes the multiple
    // triggers: on-load timer, yt-navigate-finish, and the URL poll).
    if (videoId === _sponsor.videoId) return;

    // New video → reset previous state, then set up this one.
    resetSponsorSkip();
    _sponsor.videoId = videoId;
    _sponsor.url = `https://www.youtube.com/watch?v=${videoId}`;
    console.debug("[Unbait YT] Sponsor init for", videoId, IS_YT_MOBILE ? "(mobile)" : "");

    // Cache hit → apply immediately
    const cached = await getSponsorYTCache(_sponsor.url);
    if (cached && Array.isArray(cached.segments)) {
      _sponsor.segments = cached.segments;
      attachSponsorToVideo();
      return;
    }

    requestSponsorDetection(videoId);
  } catch {
    _sponsor.pending = false;
  }
}

// Fetch the transcript in the content script (has same-origin cookies) and send
// it to the SW for LLM analysis. The previous approach of fetching from the SW
// failed on iOS because sandbox restrictions block executeScript in MAIN world,
// and SW-side InnerTube requests lack the page cookies needed on iOS.
async function requestSponsorDetection(videoId) {
  if (_sponsor.videoId !== videoId) return;
  _sponsor.pending = true;
  const title = document.title.replace(/ - YouTube$/, "").trim();

  console.debug("[Unbait YT] Sponsor: fetching transcript for", videoId);
  let transcript = null;
  try {
    // 0. Main-world bridge — fetches with the page's own cookies; the only
    //    path that works on iOS, and the cheapest on Mac (no extra requests
    //    for the current video).
    let events = await fetchCaptionEventsViaBridge(videoId, { bypassRateLimit: true });
    // 1. DOM script tags — zero extra requests, works on initial hard load.
    //    On SPA navigation YouTube updates window.ytInitialPlayerResponse but
    //    doesn't always inject a new <script> tag, so this may miss.
    if (!events) events = await fetchCaptionEventsFromDOM(videoId);
    // 2. Lightweight timedtext API — single GET per video, no signed URL needed,
    //    works on iOS, much lighter than a full page fetch.
    if (!events) {
      console.debug("[Unbait YT] Sponsor: trying timedtext API");
      events = await fetchCaptionEventsFromTimedtext(videoId);
    }
    // 3. InnerTube API — works on Mac/Chrome (session cookies shared); skip on
    //    iOS where sandbox isolation means InnerTube always returns 0 tracks.
    if (!events && !IS_IOS) {
      console.debug("[Unbait YT] Sponsor: DOM miss, trying InnerTube");
      events = await fetchTranscriptViaInnerTube(videoId, true);
    }
    // 4. Watch-page HTML fetch — heavy last-resort (500 KB HTML); skipped if
    //    rate-limited since timedtext failure probably means same block.
    if (!events) {
      console.debug("[Unbait YT] Sponsor: trying watch-page fetch");
      events = await fetchCaptionEventsFromWatchPage(videoId);
    }
    transcript = events ? buildSponsorTranscript(events) : null;
  } catch { /* ignore */ }

  if (!transcript) {
    console.debug("[Unbait YT] Sponsor: no transcript for", videoId);
    _sponsor.pending = false;
    return;
  }
  if (_sponsor.videoId !== videoId) return; // navigated away during fetch

  console.debug("[Unbait YT] Sponsor: requesting detection for", videoId);
  chrome.runtime.sendMessage({
    action: "detect-youtube-ads",
    videoId, url: _sponsor.url, title, transcript,
  }).catch(() => { _sponsor.pending = false; });
}

function handleSponsorResult(message) {
  _sponsor.pending = false;
  if (message.error) {
    // "no_transcript" = couldn't analyse (no captions); don't cache, don't show error
    if (message.error !== "no_transcript") {
      console.debug("[Unbait YT] Sponsor detection error:", message.error);
    }
    return;
  }
  const segments = Array.isArray(message.segments) ? message.segments : [];
  // Only cache when the LLM actually ran (segments may be [] = video has no sponsors)
  if (message.url) cacheSponsorYTEntry(message.url, segments);
  // Ignore stale results for a video we've since navigated away from
  if (message.url && message.url !== _sponsor.url) return;
  _sponsor.segments = segments;
  console.debug(`[Unbait YT] Sponsor segments: ${segments.length}`);
  attachSponsorToVideo();
}

function findPlayerVideo() {
  return document.querySelector(".html5-main-video")
    || document.querySelector("#movie_player video")
    || document.querySelector("video");
}

function attachSponsorToVideo(attempt = 0) {
  if (_sponsor.segments.length === 0) return;
  const video = findPlayerVideo();
  if (!video) {
    if (attempt < 10) setTimeout(() => attachSponsorToVideo(attempt + 1), 500);
    return;
  }
  // Re-bind if the video element changed (SPA can swap it)
  if (_sponsor.video && _sponsor.timeupdateHandler && _sponsor.video !== video) {
    _sponsor.video.removeEventListener("timeupdate", _sponsor.timeupdateHandler);
    _sponsor.timeupdateHandler = null;
  }
  _sponsor.video = video;

  if (!_sponsor.timeupdateHandler) {
    _sponsor.timeupdateHandler = () => onSponsorTimeUpdate(video);
    video.addEventListener("timeupdate", _sponsor.timeupdateHandler);
  }
  drawSponsorMarkers();
}

function currentSegmentAt(t) {
  for (const seg of _sponsor.segments) {
    if (t >= seg.start && t < seg.end - SPONSOR_SKIP_PAD_S) return seg;
  }
  return null;
}

function onSponsorTimeUpdate(video) {
  const seg = currentSegmentAt(video.currentTime);
  if (seg) {
    if (_sponsor.auto) {
      video.currentTime = seg.end;
      hideSponsorButton();
    } else if (_sponsor.activeSegment !== seg) {
      showSponsorButton(seg, video);
    }
  } else if (_sponsor.activeSegment) {
    hideSponsorButton();
  }
}

function getPlayerContainer() {
  return document.querySelector("#movie_player")
    || document.querySelector(".html5-video-player")
    || _sponsor.video?.parentElement;
}

function showSponsorButton(seg, video) {
  _sponsor.activeSegment = seg;

  if (!_sponsor.button) {
    _sponsor.button = document.createElement("button");
    _sponsor.button.type = "button";
  }
  const btn = _sponsor.button;

  // Mobile: fixed viewport overlay (mobile player DOM differs from desktop and
  // in-player positioning renders the button off-screen). Desktop: inside the
  // player container, above the control bar.
  if (IS_YT_MOBILE) {
    btn.className = "unbait-skip-btn unbait-skip-btn-mobile";
    if (btn.parentElement !== document.body) document.body.appendChild(btn);
  } else {
    const container = getPlayerContainer();
    if (!container) {
      // Player container not found (e.g. iOS/iPad with non-standard DOM) —
      // use fixed viewport overlay as a reliable fallback.
      btn.className = "unbait-skip-btn unbait-skip-btn-mobile";
      if (btn.parentElement !== document.body) document.body.appendChild(btn);
    } else {
      btn.className = "unbait-skip-btn";
      if (getComputedStyle(container).position === "static") {
        container.style.position = "relative";
      }
      if (btn.parentElement !== container) container.appendChild(btn);
    }
  }

  const labelKind = seg.category === "selfpromo" ? "promo" : "sponsor";
  _sponsor.button.textContent = `Skip ${labelKind} »`;
  _sponsor.button.title = seg.label || (seg.category === "selfpromo" ? "Self-promotion" : "Sponsor");
  _sponsor.button.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    video.currentTime = seg.end;
    hideSponsorButton();
  };
  _sponsor.button.style.display = "block";
}

function hideSponsorButton() {
  _sponsor.activeSegment = null;
  if (_sponsor.button) _sponsor.button.style.display = "none";
}

// Colored markers on the progress bar (best-effort, desktop player only).
function drawSponsorMarkers(attempt = 0) {
  const bar = document.querySelector(".ytp-progress-bar");
  if (!bar) return; // mobile / no desktop progress bar — skip silently
  const duration = _sponsor.video?.duration;
  if (!duration || !isFinite(duration) || duration <= 0) {
    // Duration may not be known yet; retry a few times then give up.
    if (_sponsor.segments.length > 0 && attempt < 8) {
      setTimeout(() => drawSponsorMarkers(attempt + 1), 1000);
    }
    return;
  }
  bar.querySelectorAll(".unbait-sponsor-marker").forEach((m) => m.remove());
  for (const seg of _sponsor.segments) {
    const marker = document.createElement("div");
    marker.className = "unbait-sponsor-marker " + (seg.category === "selfpromo" ? "promo" : "sponsor");
    marker.style.left = (100 * seg.start / duration) + "%";
    marker.style.width = (100 * (seg.end - seg.start) / duration) + "%";
    bar.appendChild(marker);
  }
}

// React to the toggle being switched on/off while a watch page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.ytSponsorAuto) _sponsor.auto = !!changes.ytSponsorAuto.newValue;
  if (changes.ytSponsorSkip) {
    if (changes.ytSponsorSkip.newValue) initSponsorSkip();
    else resetSponsorSkip();
  }
});

} // end double-injection guard
