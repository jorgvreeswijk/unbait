// Unbait — YouTube main-world bridge.
//
// Runs in the PAGE's JavaScript context (world: MAIN, or injected via a
// <script src> fallback), NOT in the extension's isolated world. Purpose:
// obtain caption data in a context YouTube trusts. On iOS Safari the
// extension contexts (content script + service worker) have an isolated
// cookie store, and YouTube answers those caption requests with empty 200
// bodies. Some sessions additionally require a BotGuard "POT" token on every
// timedtext request — a token only YouTube's own player can generate. For
// those, the bridge intercepts the player's own timedtext responses (fetch/
// XHR hooks) and can briefly toggle captions on so the player fetches them
// itself, with its valid token.
//
// No chrome.* APIs are available here. Communication is via window.postMessage
// with a strict namespace; the bridge only accepts an 11-char videoId and
// constructs every URL itself — it is not a generic fetch proxy.
(() => {
  if (window.__unbaitYtBridgeLoaded) return; // registered script + fallback tag may both run
  window.__unbaitYtBridgeLoaded = true;

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  function reply(msg) {
    window.postMessage({ source: "unbait-bridge", ...msg }, location.origin);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- timedtext capture: observe the player's own caption requests --------
  // The player attaches its BotGuard POT token, so its requests succeed even
  // when ours are answered with empty bodies. Hooks are installed at
  // document_start, before the player grabs fetch/XHR references.

  const _captures = new Map(); // videoId → { body, ts }

  function captureTimedtext(url, body) {
    try {
      if (!body) return;
      const u = new URL(url, location.origin);
      if (!u.pathname.startsWith("/api/timedtext")) return;
      const vid = u.searchParams.get("v");
      if (!vid || !VIDEO_ID_RE.test(vid)) return;
      _captures.set(vid, { body, ts: Date.now() });
      if (_captures.size > 10) {
        let oldest = null;
        for (const [k, v] of _captures) if (!oldest || v.ts < _captures.get(oldest).ts) oldest = k;
        _captures.delete(oldest);
      }
      console.debug("[Unbait Bridge] captured player timedtext for", vid, "len:", body.length);
    } catch { /* never break the page */ }
  }

  try {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        if (url && url.includes("/api/timedtext")) {
          p.then((resp) => {
            try { resp.clone().text().then((t) => captureTimedtext(url, t)).catch(() => {}); }
            catch { /* opaque response */ }
          }).catch(() => {});
        }
      } catch { /* ignore */ }
      return p;
    };
  } catch { /* ignore */ }

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        if (typeof url === "string" && url.includes("/api/timedtext")) {
          this.addEventListener("load", function () {
            try { captureTimedtext(url, this.responseText); } catch { /* ignore */ }
          });
        }
      } catch { /* ignore */ }
      return origOpen.call(this, method, url, ...rest);
    };
  } catch { /* ignore */ }

  // --- caption parsing (duplicated from youtube.js — worlds can't share code)

  function parseXmlCaptionsToEvents(xmlText) {
    if (!xmlText) return null;
    try {
      const doc = new DOMParser().parseFromString(xmlText, "text/xml");
      // Legacy timedtext: <transcript><text start="s" dur="s">…</text>
      let nodes = doc.querySelectorAll("text");
      if (nodes.length > 0) {
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
      }
      // srv3 (the player's own XML format): <timedtext><body><p t="ms" d="ms">
      nodes = doc.querySelectorAll("p");
      if (nodes.length > 0) {
        const events = [];
        for (const node of nodes) {
          const t = parseInt(node.getAttribute("t") || "0", 10);
          const d = parseInt(node.getAttribute("d") || "0", 10);
          const content = node.textContent || "";
          if (content.trim()) {
            events.push({ tStartMs: t, dDurationMs: d, segs: [{ utf8: content }] });
          }
        }
        return events.length > 0 ? events : null;
      }
      return null;
    } catch { return null; }
  }

  function parseCaptionText(text) {
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      if (data.events?.length > 0) return data.events;
    } catch { /* fall through to XML */ }
    return parseXmlCaptionsToEvents(text);
  }

  // --- player response resolution

  function pickTrack(tracks) {
    const lang = (navigator.language || "en").split("-")[0];
    return tracks.find((t) => t.languageCode === lang && t.kind !== "asr")
      || tracks.find((t) => t.languageCode === "en" && t.kind !== "asr")
      || tracks.find((t) => t.languageCode === "en")
      || tracks[0];
  }

  function tracksFrom(playerResponse, videoId) {
    if (!playerResponse) return null;
    if (playerResponse.videoDetails?.videoId !== videoId) return null;
    const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return tracks?.length ? tracks : null;
  }

  // The live player element exposes the player API (getPlayerResponse,
  // setOption, …). m.youtube.com has no #movie_player; duck-type candidates.
  function getPlayerEl() {
    const candidates = [
      document.getElementById("movie_player"),
      document.querySelector("#player"),
      document.querySelector(".html5-video-player"),
      document.querySelector("#player-container-id > *"),
    ];
    for (const el of candidates) {
      try {
        if (el && typeof el.getPlayerResponse === "function") return el;
      } catch { /* try next */ }
    }
    return null;
  }

  function getLocalTracks(videoId) {
    // 1. Initial player response (fresh hard load)
    let tracks = tracksFrom(window.ytInitialPlayerResponse, videoId);
    if (tracks) {
      console.debug("[Unbait Bridge]", videoId, "tracks from ytInitialPlayerResponse:", tracks.length);
      return tracks;
    }
    // 2. Live player API (desktop SPA nav — returns fresh signed URLs)
    const player = getPlayerEl();
    if (player) {
      try {
        tracks = tracksFrom(player.getPlayerResponse(), videoId);
        if (tracks) {
          console.debug("[Unbait Bridge]", videoId, "tracks from live player API:", tracks.length);
          return tracks;
        }
      } catch { /* fall through */ }
    }
    console.debug("[Unbait Bridge]", videoId, "no local tracks (player API present:", !!player + ")");
    return null;
  }

  // 3. InnerTube from page context — first-party cookies flow naturally.
  //    Origin-relative URL so it works from both www. and m.youtube.com.
  //    On sessions YouTube distrusts, InnerTube answers playability ERROR for
  //    every video; a consecutive-failure breaker stops us from hammering it
  //    (that request volume is what gets IPs flagged in the first place).
  let _innerTubeFails = 0;
  let _innerTubeBlockedUntil = 0;

  async function getInnerTubeTracks(videoId) {
    if (Date.now() < _innerTubeBlockedUntil) return null;
    const resp = await fetch(`${location.origin}/youtubei/v1/player`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            // TVHTML5_SIMPLY_EMBEDDED_PLAYER doesn't require po_token
            clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
            clientVersion: "2.0",
          },
        },
      }),
    });
    if (!resp.ok) {
      console.debug("[Unbait Bridge] InnerTube HTTP", resp.status);
      const err = new Error("innertube " + resp.status);
      err.status = resp.status;
      throw err;
    }
    const data = await resp.json();
    const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    console.debug("[Unbait Bridge] InnerTube tracks:", tracks?.length ?? 0,
      "playability:", data.playabilityStatus?.status || "?");
    if (data.playabilityStatus?.status === "ERROR" && !tracks?.length) {
      if (++_innerTubeFails >= 5) {
        _innerTubeBlockedUntil = Date.now() + 10 * 60 * 1000;
        console.debug("[Unbait Bridge] InnerTube: 5 consecutive ERRORs — pausing InnerTube for 10 min");
      }
    } else {
      _innerTubeFails = 0;
    }
    return tracks?.length ? tracks : null;
  }

  async function fetchCaptions(baseUrl) {
    // Some clients set fmt=srv3 in baseUrl — replace, don't append twice
    let url;
    if (/[?&]fmt=/.test(baseUrl)) {
      const u = new URL(baseUrl);
      u.searchParams.set("fmt", "json3");
      url = u.toString();
    } else {
      url = baseUrl + "&fmt=json3";
    }
    let resp = await fetch(url, { credentials: "include" });
    let text = resp.ok ? await resp.text() : "";
    // m.youtube.com case: baseUrl on www. can be CORS-blocked — retry host-swapped
    if ((!resp.ok || !text) && new URL(url).host !== location.host) {
      const u = new URL(url);
      u.host = location.host;
      resp = await fetch(u.toString(), { credentials: "include" });
      text = resp.ok ? await resp.text() : "";
    }
    console.debug("[Unbait Bridge] caption fetch: HTTP", resp.status,
      "ct:", resp.headers.get("content-type") || "?",
      "len:", text.length, "head:", text.slice(0, 40));
    if (resp.status === 429) {
      const err = new Error("captions 429");
      err.status = 429;
      throw err;
    }
    return parseCaptionText(text);
  }

  // --- caption toggle trick ------------------------------------------------
  // When direct fetches return empty bodies (POT token required), make the
  // player fetch the captions itself: briefly enable the caption track via
  // the player API, wait for our hook to capture the response, then restore
  // the previous caption state.

  let _togglePromise = null; // serialize concurrent toggle attempts

  function triggerCaptionLoad(videoId, track) {
    if (_togglePromise) return _togglePromise;
    _togglePromise = (async () => {
      const player = getPlayerEl();
      if (!player || typeof player.setOption !== "function") {
        console.debug("[Unbait Bridge] toggle: no player API for setOption");
        return false;
      }
      let previous = null;
      try { previous = player.getOption("captions", "track"); } catch { /* ignore */ }
      const wasOn = !!(previous && previous.languageCode);
      try {
        if (typeof player.loadModule === "function") player.loadModule("captions");
        player.setOption("captions", "track", {
          languageCode: track.languageCode,
          ...(track.kind ? { kind: track.kind } : {}),
        });
        console.debug("[Unbait Bridge] toggle: enabled captions", track.languageCode, track.kind || "");
      } catch (e) {
        console.debug("[Unbait Bridge] toggle: setOption failed:", e.message);
        return false;
      }
      // Wait for the player's timedtext request to be captured
      for (let i = 0; i < 30 && !_captures.has(videoId); i++) await sleep(200);
      // Restore previous state
      try {
        if (wasOn) {
          player.setOption("captions", "track", previous);
        } else {
          player.setOption("captions", "track", {});
          if (typeof player.unloadModule === "function") player.unloadModule("captions");
        }
      } catch { /* ignore */ }
      const got = _captures.has(videoId);
      console.debug("[Unbait Bridge] toggle: done, captured:", got);
      return got;
    })().finally(() => { _togglePromise = null; });
    return _togglePromise;
  }

  function eventsFromCapture(videoId) {
    const cap = _captures.get(videoId);
    if (!cap) return null;
    return parseCaptionText(cap.body);
  }

  async function handleTranscriptRequest(videoId, requestId) {
    try {
      // 0. Player already fetched these captions (user had CC on, or an
      //    earlier toggle) — zero requests.
      let events = eventsFromCapture(videoId);
      if (events?.length) {
        reply({ type: "unbait-transcript-result", requestId, ok: true, events, via: "capture" });
        return;
      }

      let via = "player";
      let tracks = getLocalTracks(videoId);
      const isCurrentVideo = !!tracks; // local tracks only resolve for the playing video
      if (!tracks) {
        via = "innertube";
        try { tracks = await getInnerTubeTracks(videoId); } catch (e) {
          if (e.status === 429) throw e;
          tracks = null;
        }
      }
      if (!tracks) {
        reply({ type: "unbait-transcript-result", requestId, ok: false, status: 0 });
        return;
      }

      // 1. Direct fetch of the caption URL (works on trusted sessions — Mac)
      events = await fetchCaptions(pickTrack(tracks).baseUrl);

      // 2. Empty body → POT token required. Let the player fetch it for us.
      //    Only possible for the currently playing video.
      if (!events?.length && isCurrentVideo) {
        via = "toggle";
        if (await triggerCaptionLoad(videoId, pickTrack(tracks))) {
          events = eventsFromCapture(videoId);
        }
      }

      if (events?.length) {
        reply({ type: "unbait-transcript-result", requestId, ok: true, events, via });
      } else {
        reply({ type: "unbait-transcript-result", requestId, ok: false, status: 0 });
      }
    } catch (e) {
      console.debug("[Unbait Bridge]", videoId, "exception:", e.message);
      reply({
        type: "unbait-transcript-result", requestId,
        ok: false, status: e.status || 0,
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== "unbait-cs") return;

    if (data.type === "unbait-bridge-ping") {
      reply({ type: "unbait-bridge-pong", requestId: data.requestId, v: 1 });
      return;
    }
    if (data.type === "unbait-transcript-request") {
      if (typeof data.videoId !== "string" || !VIDEO_ID_RE.test(data.videoId)) return;
      handleTranscriptRequest(data.videoId, data.requestId);
    }
  });
})();
