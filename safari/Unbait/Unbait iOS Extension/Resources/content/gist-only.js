// Lightweight Gist-only content script.
// Loaded on sites where mode === "gist", or globally when "Apply Gist to all
// other sites" is on. Skips title rewriting entirely — only injects G-icons
// next to headlines so the user can request a summary on demand.

if (!window.__unbaitGistOnlyLoaded) {
window.__unbaitGistOnlyLoaded = true;

(function () {
  const MIN_HEADLINE_LENGTH = 25;
  const MAX_HEADLINE_LENGTH = 250;
  const MIN_PATH_LENGTH = 4;
  const GIST_CACHE_PREFIX = "gist_cache_";
  const CACHE_MAX_ENTRIES = 200;
  const SCAN_DEBOUNCE_MS = 500;

  const _gistSource = new Map();

  function isNavigationElement(el) {
    if (el.closest("article")) return false;
    if (el.closest("nav, header, footer, [role='navigation'], [role='banner'], [role='contentinfo'], aside")) return true;
    const id = ((el.className || "") + " " + (el.id || "")).toLowerCase();
    return /\b(nav|menu|breadcrumb|sidebar|cookie|banner|skip)\b/.test(id);
  }

  function extractText(element) {
    return (element.textContent || "").replace(/­/g, "").replace(/\s+/g, " ").trim();
  }

  function isValidUrl(href) {
    try {
      const url = new URL(href);
      if (url.pathname === "/" || url.pathname.length < MIN_PATH_LENGTH) return false;
      return /^https?:/.test(url.protocol);
    } catch {
      return false;
    }
  }

  function alreadyMarked(element) {
    if (element.classList.contains("unbait-replaced")) return true;
    if (element.querySelector(".unbait-replaced, .unbait-icon, .gist-icon")) return true;
    if (element.nextElementSibling?.classList?.contains("gist-icon")) return true;
    return false;
  }

  // Detect single-article pages. We treat these specially: place a single G
  // next to the H1 instead of running the listing-page logic.
  function isSingleArticlePage() {
    const h1Count = document.querySelectorAll("h1").length;
    const article = document.querySelector("article");
    if (!article) return false;
    if (h1Count !== 1) return false;
    // Heuristic: article body has substantial text content.
    return article.textContent.length > 600;
  }

  function findCandidatesListing() {
    const found = [];
    const seen = new Set();

    const addCandidate = (element, href) => {
      if (!isValidUrl(href)) return;
      if (seen.has(element)) return;
      if (alreadyMarked(element)) return;
      if (isNavigationElement(element)) return;
      const text = extractText(element);
      if (text.length < MIN_HEADLINE_LENGTH || text.length > MAX_HEADLINE_LENGTH) return;
      seen.add(element);
      found.push({ element, text, url: href });
    };

    // Strategy 1: <a> wrapping a heading
    document.querySelectorAll("a h1, a h2, a h3, a h4").forEach((heading) => {
      const anchor = heading.closest("a");
      if (anchor) addCandidate(heading, anchor.href);
    });

    // Strategy 2: heading containing an <a>
    document.querySelectorAll("h1 a, h2 a, h3 a, h4 a").forEach((anchor) => {
      const heading = anchor.closest("h1, h2, h3, h4");
      if (heading) addCandidate(heading, anchor.href);
    });

    return found;
  }

  function shouldRunListing() {
    const headingCount = document.querySelectorAll("h1, h2, h3").length;
    const hasMain = !!document.querySelector("article, main");
    return headingCount >= 2 || hasMain;
  }

  function injectIcons() {
    if (isSingleArticlePage()) {
      const h1 = document.querySelector("article h1") || document.querySelector("main h1") || document.querySelector("h1");
      if (h1 && !alreadyMarked(h1)) {
        const text = extractText(h1);
        if (text.length >= MIN_HEADLINE_LENGTH) {
          appendGIcon(h1, location.href, text);
        }
      }
      return;
    }

    if (!shouldRunListing()) return;
    const items = findCandidatesListing();
    for (const item of items) {
      appendGIcon(item.element, item.url, item.text);
    }
  }

  function appendGIcon(element, url, title) {
    const gIcon = document.createElement("span");
    gIcon.className = "gist-icon";
    gIcon.title = "Get the gist";
    gIcon.setAttribute("role", "button");
    gIcon.setAttribute("tabindex", "0");
    gIcon.setAttribute("aria-label", "Show summary");
    gIcon.dataset.gistUrl = url;
    gIcon.dataset.gistTitle = title;
    element.appendChild(gIcon);
  }

  // ---------------------------------------------------------------------------
  // Click handling (mirrors content.js handleGistClickFromGIcon, simplified)
  // ---------------------------------------------------------------------------

  function gistFooterRenderer(footer, url) {
    footer.textContent = "";
    const domain = document.createElement("span");
    try { domain.textContent = new URL(url).hostname; } catch { domain.textContent = ""; }
    footer.appendChild(domain);
    const known = _gistSource.get(url);
    if (known === undefined || known === null) return;
    const sep = document.createElement("span");
    sep.textContent = " · ";
    sep.style.opacity = "0.4";
    footer.appendChild(sep);
    const badge = document.createElement("span");
    badge.textContent = known ? "article" : "title only";
    badge.style.fontWeight = "500";
    badge.className = known ? "gist-source-transcript" : "gist-source-title";
    footer.appendChild(badge);
  }

  async function handleGistClick(gIcon) {
    const url = gIcon.dataset.gistUrl;
    const title = gIcon.dataset.gistTitle;
    if (!url || !title) return;

    if (Unbait.gistActiveUrl === url && Unbait.gistActiveOverlay) {
      Unbait.gistCloseOverlay();
      return;
    }

    Unbait.gistShowOverlay(gIcon, url, gistFooterRenderer);

    const cached = await Unbait.getGistCache(url, GIST_CACHE_PREFIX);
    if (cached) {
      if (typeof cached.hasContent === "boolean") _gistSource.set(url, cached.hasContent);
      if (Unbait.gistActiveOverlay && Unbait.gistActiveUrl === url) {
        const footer = Unbait.gistActiveOverlay.querySelector(".gist-overlay-footer");
        if (footer) gistFooterRenderer(footer, url);
        const body = Unbait.gistActiveOverlay.querySelector(".gist-overlay-body");
        if (body) Unbait.gistRenderText(body, cached.summary);
      }
      return;
    }

    if (Unbait.gistPendingRequests.has(url)) return;
    Unbait.gistPendingRequests.add(url);

    chrome.runtime.sendMessage({ action: "summarize-article", url, title }).catch(() => {
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

  document.addEventListener("click", (e) => {
    const gIcon = e.target.closest(".gist-icon");
    if (!gIcon) return;
    e.preventDefault();
    e.stopPropagation();
    handleGistClick(gIcon);
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const gIcon = e.target.closest(".gist-icon");
    if (!gIcon) return;
    e.preventDefault();
    handleGistClick(gIcon);
  }, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "gist-stream") {
      if (message.url !== Unbait.gistActiveUrl || !Unbait.gistActiveOverlay) return;
      const body = Unbait.gistActiveOverlay.querySelector(".gist-overlay-body");
      if (body) Unbait.gistRenderText(body, message.text);
      return;
    }
    if (message.action === "gist-result") {
      Unbait.gistPendingRequests.delete(message.url);
      if (typeof message.hasContent === "boolean") {
        _gistSource.set(message.url, message.hasContent);
      }
      if (message.url !== Unbait.gistActiveUrl || !Unbait.gistActiveOverlay) {
        if (message.summary) {
          Unbait.cacheGistEntry(message.url, message.summary, GIST_CACHE_PREFIX, CACHE_MAX_ENTRIES, { hasContent: message.hasContent });
        }
        return;
      }
      const footer = Unbait.gistActiveOverlay.querySelector(".gist-overlay-footer");
      if (footer) gistFooterRenderer(footer, message.url);
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
        Unbait.cacheGistEntry(message.url, message.summary, GIST_CACHE_PREFIX, CACHE_MAX_ENTRIES, { hasContent: message.hasContent });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Initial scan + SPA observer
  // ---------------------------------------------------------------------------

  function runInjection() {
    try { injectIcons(); } catch (e) { console.debug("[Unbait] gist-only inject failed:", e?.message); }
  }

  let _scanTimer = null;
  function scheduleScan() {
    if (_scanTimer) clearTimeout(_scanTimer);
    _scanTimer = setTimeout(runInjection, SCAN_DEBOUNCE_MS);
  }

  function startObserver() {
    const root = document.body || document.documentElement;
    if (!root) return;
    const observer = new MutationObserver(scheduleScan);
    observer.observe(root, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      runInjection();
      startObserver();
    });
  } else {
    runInjection();
    startObserver();
  }
})();

} // end guard
