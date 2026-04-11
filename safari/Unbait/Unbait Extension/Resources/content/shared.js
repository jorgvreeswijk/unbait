// Shared utilities for content.js and youtube.js
// Loaded first via chrome.scripting.executeScript files array.
if (!window.__unbaitSharedLoaded) {
window.__unbaitSharedLoaded = true;

window.Unbait = (function () {

  // ---------------------------------------------------------------------------
  // Gist state (private)
  // ---------------------------------------------------------------------------

  let _gistEnabled = true;
  let _gistClickMode = "summary";
  let _gistAutoClose = true;
  let _gistActiveOverlay = null;
  let _gistActiveUrl = null;
  let _gistActiveIconEl = null;
  let _gistScrollTimer = null;
  const _gistPendingRequests = new Set();

  // Per-prefix write queues for cache serialization
  const _writeQueues = {};

  // Gist cache write queue
  let _gistCacheWriteQueue = Promise.resolve();

  // ---------------------------------------------------------------------------
  // Gist settings init
  // ---------------------------------------------------------------------------

  chrome.storage.local.get(["gistEnabled", "gistClickMode", "gistAutoClose"], (data) => {
    _gistEnabled = data.gistEnabled !== false;
    _gistClickMode = data.gistClickMode || "summary";
    _gistAutoClose = data.gistAutoClose !== false;
  });

  // Live-update settings when changed from popup
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.gistEnabled) _gistEnabled = changes.gistEnabled.newValue !== false;
    if (changes.gistClickMode) _gistClickMode = changes.gistClickMode.newValue || "summary";
    if (changes.gistAutoClose) _gistAutoClose = !!changes.gistAutoClose.newValue;
  });

  // ---------------------------------------------------------------------------
  // Provider / cache helpers
  // ---------------------------------------------------------------------------

  async function getCurrentProvider() {
    const data = await chrome.storage.local.get("provider");
    return data.provider || "anthropic";
  }

  function cacheKeyForPrefix(prefix, provider) {
    return `${prefix}${provider || "anthropic"}`;
  }

  async function getCache(prefix, provider) {
    if (!provider) provider = await getCurrentProvider();
    const key = cacheKeyForPrefix(prefix, provider);
    const data = await chrome.storage.local.get(key);
    return data[key] || {};
  }

  function setCacheEntries(entries, prefix, maxAgeMs, maxEntries, provider) {
    if (!_writeQueues[prefix]) _writeQueues[prefix] = Promise.resolve();

    _writeQueues[prefix] = _writeQueues[prefix].then(async () => {
      if (!provider) provider = await getCurrentProvider();
      const key = cacheKeyForPrefix(prefix, provider);
      const cache = await getCache(prefix, provider);
      const now = Date.now();

      for (const [url, value] of Object.entries(entries)) {
        if (typeof value === "string") {
          cache[url] = { newTitle: value, ts: now };
        } else {
          cache[url] = { newTitle: value.newTitle, originalTitle: value.originalTitle, ts: now };
        }
      }

      // Prune expired
      for (const [url, entry] of Object.entries(cache)) {
        if (now - entry.ts > maxAgeMs) {
          delete cache[url];
        }
      }

      // Cap size
      const cacheEntries = Object.entries(cache);
      if (cacheEntries.length > maxEntries) {
        cacheEntries.sort((a, b) => a[1].ts - b[1].ts);
        cacheEntries.slice(0, cacheEntries.length - maxEntries).forEach(([url]) => delete cache[url]);
      }

      await chrome.storage.local.set({ [key]: cache });
    });
  }

  // ---------------------------------------------------------------------------
  // Gist overlay
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

  /**
   * Show the gist overlay near an icon element.
   * @param {Element} iconEl - The icon element to position near
   * @param {string} url - The URL being summarized
   * @param {function} [footerRenderer] - Optional callback(footerEl, url) to customize footer content.
   *   Defaults to showing the URL hostname.
   */
  function gistShowOverlay(iconEl, url, footerRenderer) {
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
    if (footerRenderer) {
      footerRenderer(footer, url);
    } else {
      try { footer.textContent = new URL(url).hostname; } catch { footer.textContent = ""; }
    }

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
    if (_gistActiveOverlay) {
      _gistActiveOverlay.remove();
      _gistActiveOverlay = null;
      _gistActiveUrl = null;
      _gistActiveIconEl = null;
    }
    document.removeEventListener("keydown", _gistEscHandler);
    document.removeEventListener("click", _gistOutsideClickHandler);
    window.removeEventListener("scroll", _gistScrollHandler, { capture: true });
  }

  function _gistEscHandler(e) {
    if (e.key === "Escape") gistCloseOverlay();
  }

  function _gistOutsideClickHandler(e) {
    if (_gistActiveOverlay && !_gistActiveOverlay.contains(e.target) && !e.target.classList.contains("unbait-icon")) {
      gistCloseOverlay();
    }
  }

  function _gistScrollHandler(e) {
    if (!_gistActiveOverlay || !_gistActiveIconEl) return;
    // Auto-close: close immediately on any scroll outside the overlay
    if (_gistAutoClose) {
      if (!_gistActiveOverlay.contains(e.target)) {
        gistCloseOverlay();
        return;
      }
      return; // scrolling inside overlay — don't reposition
    }
    // Default: reposition overlay to follow the icon
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
      overlay.style.top = (rect.bottom + pad) + "px";
      overlay.style.bottom = "";
      overlay.style.maxHeight = Math.min(maxH, spaceBelow) + "px";
    } else {
      overlay.style.top = "";
      overlay.style.bottom = (window.innerHeight - rect.top + pad) + "px";
      overlay.style.maxHeight = Math.min(maxH, spaceAbove) + "px";
    }
  }

  // ---------------------------------------------------------------------------
  // Gist cache helpers
  // ---------------------------------------------------------------------------

  async function getGistCache(url, cachePrefix) {
    const provider = await getCurrentProvider();
    const cacheKey = `${cachePrefix}${provider}`;
    const cacheData = await chrome.storage.local.get(cacheKey);
    const cache = cacheData[cacheKey] || {};
    const entry = cache[url];
    // 7 days TTL
    if (entry && Date.now() - entry.ts < 7 * 24 * 60 * 60 * 1000) return entry;
    return null;
  }

  function cacheGistEntry(url, summary, cachePrefix, maxEntries, extraFields) {
    _gistCacheWriteQueue = _gistCacheWriteQueue.then(async () => {
      const provider = await getCurrentProvider();
      const cacheKey = `${cachePrefix}${provider}`;
      const cacheData = await chrome.storage.local.get(cacheKey);
      const cache = cacheData[cacheKey] || {};
      cache[url] = { summary, ts: Date.now(), ...extraFields };
      const keys = Object.keys(cache);
      if (keys.length > maxEntries) {
        keys.sort((a, b) => cache[a].ts - cache[b].ts);
        for (let i = 0; i < keys.length - maxEntries; i++) delete cache[keys[i]];
      }
      await chrome.storage.local.set({ [cacheKey]: cache });
    }).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function decodeEntities(str) {
    return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    // Provider / cache
    getCurrentProvider,
    getCache,
    setCacheEntries,

    // Gist overlay
    gistRenderVerdictBadge,
    gistRenderText,
    gistShowOverlay,
    gistCloseOverlay,
    gistPositionOverlay,

    // Gist cache
    getGistCache,
    cacheGistEntry,

    // Gist state accessors
    get gistEnabled() { return _gistEnabled; },
    get gistClickMode() { return _gistClickMode; },
    get gistActiveOverlay() { return _gistActiveOverlay; },
    get gistActiveUrl() { return _gistActiveUrl; },
    get gistActiveIconEl() { return _gistActiveIconEl; },
    get gistPendingRequests() { return _gistPendingRequests; },

    // Utilities
    decodeEntities,
  };
})();

} // end guard
