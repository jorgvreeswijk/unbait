// Track active job status per tab
const _tabStatus = new Map();

// Detect Safari (desktop + iOS). Safari's MV3 service workers are killed
// aggressively after ~5s idle and SSE streaming via ReadableStream is unreliable.
// We use this flag to fall back to small non-streaming batches.
const IS_SAFARI = (() => {
  try {
    const ua = navigator.userAgent || "";
    return /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS/.test(ua);
  } catch { return false; }
})();

// Migrate autoSites from sync to local (one-time, for Safari compatibility)
chrome.storage.sync.get("autoSites").then((syncData) => {
  if (syncData.autoSites && syncData.autoSites.length > 0) {
    chrome.storage.local.get("autoSites").then((localData) => {
      if (!localData.autoSites || localData.autoSites.length === 0) {
        chrome.storage.local.set({ autoSites: syncData.autoSites });
      }
      // Clean up sync storage
      chrome.storage.sync.remove("autoSites");
    });
  }
}).catch(() => {});

// Increment lifetime statistics
async function incrementStats(field, amount) {
  if (!amount || amount <= 0) return;
  try {
    const data = await chrome.storage.local.get("unbait_stats");
    const stats = data.unbait_stats || {};
    stats[field] = (stats[field] || 0) + amount;
    if (!stats.firstUsed) stats.firstUsed = Date.now();
    await chrome.storage.local.set({ unbait_stats: stats });
  } catch { /* best-effort */ }
}

// Is OffscreenCanvas usable in this service worker context?
// Safari's MV3 service worker does not implement OffscreenCanvas.
const HAS_OFFSCREEN_CANVAS = (() => {
  try { return typeof OffscreenCanvas !== "undefined" && !!new OffscreenCanvas(1, 1).getContext("2d"); }
  catch { return false; }
})();

// Generate a dynamic icon: teal circle with text (replaces entire icon)
function generateIcon(text, bgColor) {
  const size = 128;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Draw teal circle
  ctx.fillStyle = bgColor || "#0d9488";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Draw text
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (text.length <= 2) {
    ctx.font = `bold ${size * 0.55}px -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif`;
  } else {
    ctx.font = `bold ${size * 0.35}px -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif`;
  }
  ctx.fillText(text, size / 2, size / 2 + 2);

  return ctx.getImageData(0, 0, size, size);
}

function updateBadge(tabId, state, count) {
  // Safari (and any browser without OffscreenCanvas in SW): fall back to
  // setBadgeText on top of the static toolbar icon. This keeps visible
  // feedback for working/done/error states without needing canvas.
  if (!HAS_OFFSCREEN_CANVAS) {
    try {
      if (state === "working") {
        chrome.action.setBadgeBackgroundColor({ color: "#0d9488", tabId });
        chrome.action.setBadgeText({ text: "…", tabId });
      } else if (state === "done") {
        chrome.action.setBadgeBackgroundColor({ color: "#0d9488", tabId });
        chrome.action.setBadgeText({ text: count > 0 ? String(count) : "\u2713", tabId });
      } else if (state === "error") {
        chrome.action.setBadgeBackgroundColor({ color: "#ef4444", tabId });
        chrome.action.setBadgeText({ text: "!", tabId });
      } else {
        chrome.action.setBadgeText({ text: "", tabId });
      }
    } catch { /* badge API unavailable */ }
    return;
  }

  try {
    // Clear any badge text (we use full icon replacement instead)
    chrome.action.setBadgeText({ text: "", tabId });

    if (state === "working") {
      const imageData = generateIcon("···", "#0d9488");
      chrome.action.setIcon({ imageData, tabId });
    } else if (state === "done") {
      const text = count > 0 ? String(count) : "\u2713";
      const imageData = generateIcon(text, "#0d9488");
      chrome.action.setIcon({ imageData, tabId });
    } else if (state === "error") {
      const imageData = generateIcon("!", "#ef4444");
      chrome.action.setIcon({ imageData, tabId });
    } else {
      // Reset to default U icon (use canvas to avoid fetch issues in service worker)
      const imageData = generateIcon("U", "#0d9488");
      chrome.action.setIcon({ imageData, tabId });
    }
  } catch {
    // Icon API may not be available in all contexts
  }
}

// Inject content script and trigger de-clickbait on a tab
function triggerDeclickbait(tabId) {
  if (!tabId) return;
  updateBadge(tabId, "working");

  const YT_HOSTS = ["www.youtube.com", "youtube.com", "m.youtube.com"];
  chrome.tabs.get(tabId).then((tab) => {
    let isYouTube = false;
    try { isYouTube = YT_HOSTS.includes(new URL(tab.url).hostname); } catch {}

    if (isYouTube) {
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/shared.js", "content/youtube.js"],
      }).then(() => {
        chrome.scripting.insertCSS({ target: { tabId }, files: ["content/content.css"] });
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { action: "de-clickbait-youtube" }).catch(() => {});
        }, CONFIG.AUTO_TRIGGER_DELAY_MS);
      }).catch(() => {});
    } else {
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/shared.js", "content/content.js"],
      }).then(() => {
        chrome.scripting.insertCSS({ target: { tabId }, files: ["content/content.css"] });
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { action: "de-clickbait" }).catch(() => {});
        }, CONFIG.AUTO_TRIGGER_DELAY_MS);
      }).catch(() => {});
    }
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Verify sender is from our own extension or a valid tab
  if (sender.id !== chrome.runtime.id) return;

  if (message.action === "get-status") {
    const status = _tabStatus.get(message.tabId) || null;
    sendResponse(status);
    return;
  }

  if (message.action === "enable-site") {
    // Service worker handles site enable to survive popup closing
    const { hostname, tabId } = message;
    if (!hostname) return;
    const YT_HOSTS = ["www.youtube.com", "youtube.com", "m.youtube.com"];
    const isYT = YT_HOSTS.includes(hostname);

    chrome.storage.local.get("autoSites").then(async (data) => {
      const sites = data.autoSites || [];
      if (!sites.includes(hostname)) {
        sites.push(hostname);
        await chrome.storage.local.set({ autoSites: sites });
      }
      if (isYT) {
        await chrome.storage.local.set({ youtubeEnabled: true });
      }
      // Trigger de-clickbait directly (not via message — that doesn't work within same listener)
      if (tabId) {
        triggerDeclickbait(tabId);
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "disable-site") {
    const { hostname } = message;
    if (!hostname) return;
    const YT_HOSTS = ["www.youtube.com", "youtube.com", "m.youtube.com"];
    const isYT = YT_HOSTS.includes(hostname);

    chrome.storage.local.get("autoSites").then(async (data) => {
      const sites = (data.autoSites || []).filter((s) => s !== hostname);
      await chrome.storage.local.set({ autoSites: sites });
      if (isYT) {
        await chrome.storage.local.set({ youtubeEnabled: false });
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "trigger-declickbait") {
    triggerDeclickbait(message.tabId);
    return;
  }

  if (message.action === "rewrite-headlines") {
    const tabId = sender.tab?.id;
    _tabStatus.set(tabId, { state: "working", text: "Scanning headlines..." });
    updateBadge(tabId, "working");

    // Respond immediately to avoid Safari killing the message channel
    sendResponse({ accepted: true });

    handleRewrite(message.headlines, tabId).then((result) => {
      if (result && result.error) {
        _tabStatus.set(tabId, { state: "error", text: result.error });
        updateBadge(tabId, "error");
      } else if (result && result.results) {
        const count = result.results.filter((r) => r.newTitle).length;
        _tabStatus.set(tabId, {
          state: "done",
          text: "Done!",
          found: message.headlines.length,
          count,
        });
        updateBadge(tabId, "done", count);
        incrementStats("totalUnbaited", count);
      } else {
        _tabStatus.delete(tabId);
        updateBadge(tabId, "clear");
      }
      // Send final result via tabs.sendMessage (survives SW lifecycle)
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          action: "rewrite-complete",
          result,
          found: message.headlines.length,
        }).catch(() => {});
      }
    });
    return; // already responded synchronously
  }

  if (message.action === "rewrite-youtube-titles") {
    const tabId = sender.tab?.id;
    _tabStatus.set(tabId, { state: "working", text: "Processing YouTube titles..." });
    updateBadge(tabId, "working");
    sendResponse({ accepted: true });

    handleRewrite(message.headlines, tabId, "youtube").then((result) => {
      if (result && result.error) {
        _tabStatus.set(tabId, { state: "error", text: result.error });
        updateBadge(tabId, "error");
      } else if (result && result.results) {
        const count = result.results.filter((r) => r.newTitle).length;
        _tabStatus.set(tabId, {
          state: "done", text: "Done!",
          found: message.headlines.length,
          count,
        });
        updateBadge(tabId, "done", count);
        incrementStats("totalUnbaited", count);
      }
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          action: "yt-rewrite-complete",
          result: result || { results: [] },
          found: message.headlines?.length || 0,
        }).catch(() => {});
      }
    });
    return true;
  }

  if (message.action === "update-badge-count") {
    const tabId = sender.tab?.id;
    if (tabId && message.count > 0) {
      updateBadge(tabId, "done", message.count);
    }
    return;
  }

  if (message.action === "get-tab-status") {
    const tabId = message.tabId;
    const status = _tabStatus.get(tabId) || null;
    sendResponse(status);
    return;
  }

  if (message.action === "summarize-article") {
    const tabId = sender.tab?.id;
    sendResponse({ accepted: true });
    handleSummarizeArticle(message, tabId);
    return true;
  }

  if (message.action === "summarize-youtube") {
    const tabId = sender.tab?.id;
    sendResponse({ accepted: true });
    handleSummarizeYouTube(message, tabId);
    return true;
  }
});

const CONFIG = {
  CONTEXT_CONCURRENCY: 10,
  CONTEXT_TIMEOUT_MS: 6000,
  CONTEXT_MAX_BYTES: 131072,
  CONTEXT_MAX_CHARS: 800,
  META_DESC_MAX_CHARS: 300,
  JSONLD_MAX_CHARS: 600,
  MIN_PARAGRAPH_LENGTH: 40,
  PARAGRAPH_MAX_CHARS: 600,
  MAX_TITLE_LENGTH: 80,
  GEMINI_BATCH_SIZE: 60,
  GEMINI_BATCH_DELAY_MS: 15000,
  GEMINI_MAX_RETRIES: 2,
  GEMINI_RETRY_BASE_MS: 10000,
  CLAUDE_MAX_TOKENS: 4096,
  OPENAI_MAX_TOKENS: 4096,
  GEMINI_MAX_TOKENS: 8192,
  AUTO_TRIGGER_DELAY_MS: 500,
};

// Always On: auto-trigger on page load for configured sites
// Also: inject content script for cache restore on any previously de-clickbaited site
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Clear badge when navigating to a new page
  if (changeInfo.status === "loading") {
    updateBadge(tabId, "clear");
    _tabStatus.delete(tabId);
  }
  if (changeInfo.status !== "complete" || !tab.url) return;

  try {
    const hostname = new URL(tab.url).hostname;

    Promise.all([
      chrome.storage.local.get("autoSites"),
      chrome.storage.local.get(["apiKey", "apiKey_anthropic", "apiKey_openai", "apiKey_gemini", "provider"]),
    ]).then(async ([syncData, localData]) => {
      const autoSites = syncData.autoSites || [];
      const provider = localData.provider || "anthropic";
      const apiKey = localData[`apiKey_${provider}`] || localData.apiKey;
      const isAlwaysOn = apiKey && autoSites.includes(hostname);

      // Check if there are cached entries for this site's domain
      let hasCachedEntries = false;
      if (!isAlwaysOn) {
        try {
          const cacheKey = `unbait_cache_${provider}`;
          const data = await chrome.storage.local.get(cacheKey);
          const cache = data[cacheKey] || {};
          hasCachedEntries = Object.keys(cache).some((url) => {
            try { return new URL(url).hostname === hostname; } catch { return false; }
          });
        } catch {
          // ignore cache check errors
        }
      }

      if (!isAlwaysOn && !hasCachedEntries) return;

      // Skip content.js for YouTube — it uses youtube.js (handled separately below)
      const YT_HOSTS_CHECK = ["www.youtube.com", "youtube.com", "m.youtube.com"];
      if (YT_HOSTS_CHECK.includes(hostname)) return;

      // Inject content script + CSS
      // The content script auto-restores cached titles on load
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/shared.js", "content/content.js"],
      }).then(() => {
        chrome.scripting.insertCSS({
          target: { tabId },
          files: ["content/content.css"],
        });

        // Only trigger full de-clickbait for Always On sites
        if (isAlwaysOn) {
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: "de-clickbait" }).catch(() => {});
          }, CONFIG.AUTO_TRIGGER_DELAY_MS);
        }
      }).catch((e) => console.debug("[Unbait] Auto-inject failed:", e.message));
    });

    // YouTube support: inject youtube.js if youtubeEnabled OR Always On for YouTube
    const YT_HOSTS = ["www.youtube.com", "youtube.com", "m.youtube.com"];
    if (YT_HOSTS.includes(hostname)) {
      Promise.all([
        chrome.storage.local.get("youtubeEnabled"),
        chrome.storage.local.get("autoSites"),
      ]).then(([ytData, syncData]) => {
        const autoSites = syncData.autoSites || [];
        const isYTAlwaysOn = autoSites.some((s) => YT_HOSTS.includes(s));
        if (ytData.youtubeEnabled || isYTAlwaysOn) {
          chrome.scripting.executeScript({
            target: { tabId },
            files: ["content/shared.js", "content/youtube.js"],
          }).then(() => {
            chrome.scripting.insertCSS({
              target: { tabId },
              files: ["content/content.css"],
            });
            // Auto-trigger if Always On
            if (isYTAlwaysOn) {
              setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { action: "de-clickbait-youtube" }).catch(() => {});
              }, CONFIG.AUTO_TRIGGER_DELAY_MS);
            }
          }).catch(() => {});
        }
      });
    }
  } catch {
    // invalid URL, skip
  }
});

async function handleRewrite(headlines, tabId, mode = "news") {
  const data = await chrome.storage.local.get(["provider", "apiKey_anthropic", "apiKey_openai", "apiKey_gemini", "apiKey", "summaryLanguage"]);
  const provider = data.provider || "anthropic";

  // Migrate old key format
  let apiKey = data[`apiKey_${provider}`];
  if (!apiKey && provider === "anthropic" && data.apiKey) {
    apiKey = data.apiKey;
  }

  if (!apiKey) {
    return { error: "No API key set. Open the Unbait popup to enter your key." };
  }

  // Check if content script already provided context (Safari-compatible path)
  const hasContentScriptContext = headlines.some(h => h.context);
  let enriched;
  if (hasContentScriptContext) {
    // Content script already fetched context — only enrich cross-domain headlines without context
    const needsContext = headlines.filter(h => !h.context);
    const hasContext = headlines.filter(h => h.context);
    if (needsContext.length > 0) {
      _tabStatus.set(tabId, { state: "working", text: "Fetching cross-domain context..." });
      const crossDomainEnriched = await enrichWithContext(needsContext);
      enriched = [...hasContext, ...crossDomainEnriched];
    } else {
      enriched = headlines;
    }
    console.debug(`[Unbait] Context: ${hasContext.length} from content script, ${needsContext.length} cross-domain`);
  } else {
    // Fallback: fetch all context from service worker (Chrome path)
    _tabStatus.set(tabId, { state: "working", text: "Fetching article context..." });
    enriched = await enrichWithContext(headlines);
  }

  // Call the selected provider
  _tabStatus.set(tabId, { state: "working", text: `Rewriting with ${provider}...` });
  console.debug(`[Unbait] Calling ${provider} with ${enriched.length} headlines`);
  const streamAction = mode === "youtube" ? "yt-stream-result" : "stream-result";
  const lang = data.summaryLanguage || "auto";
  const result = await callProvider(provider, apiKey, enriched, tabId, mode, streamAction, lang);
  console.debug(`[Unbait] ${provider} returned:`, result.error || `${result.results?.length || 0} results`);
  return result;
}

async function callProvider(provider, apiKey, headlines, tabId, mode = "news", streamAction = "stream-result", lang = "auto") {
  switch (provider) {
    case "openai":
      return await callOpenAI(apiKey, headlines, tabId, mode, streamAction, lang);
    case "gemini":
      return await callGemini(apiKey, headlines, tabId, mode, streamAction, lang);
    case "anthropic":
    default:
      return await callClaudeStreaming(apiKey, headlines, tabId, mode, streamAction, lang);
  }
}

/**
 * Validate parsed results array, filtering out malformed entries.
 */
function validateResults(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(r => r && typeof r.id === "string" && (r.newTitle === null || typeof r.newTitle === "string"));
}

/**
 * Context fetching: read the first ~128KB of each page (enough for <head> + article body).
 * Extract meta description + first paragraphs for rich context.
 */
async function enrichWithContext(headlines) {
  const results = [];

  for (let i = 0; i < headlines.length; i += CONFIG.CONTEXT_CONCURRENCY) {
    const batch = headlines.slice(i, i + CONFIG.CONTEXT_CONCURRENCY);
    const promises = batch.map(async (h) => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.CONTEXT_TIMEOUT_MS);
        const resp = await fetch(h.url, { signal: controller.signal, credentials: "omit", referrer: "" });
        clearTimeout(timeoutId);

        if (!resp.ok) return { ...h, context: "" };

        const contentType = resp.headers.get("content-type") || "";
        if (!contentType.includes("text/html") && !contentType.includes("text/xml") && !contentType.includes("application/xhtml")) {
          return { ...h, context: "" };
        }

        // Read first ~128KB (enough for <head> + article body)
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let html = "";
        let bytesRead = 0;

        while (bytesRead < CONFIG.CONTEXT_MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          html += decoder.decode(value, { stream: true });
          bytesRead += value.length;
        }
        reader.cancel();

        const context = extractContext(html);
        return { ...h, context };
      } catch {
        return { ...h, context: "" };
      }
    });
    results.push(...(await Promise.all(promises)));
  }

  return results;
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract meta description from HTML <head>.
 */
function extractMetaDescription(html) {
  const ogMatch = html.match(
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
  );
  const ogMatch2 = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i
  );
  const metaMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
  );
  const metaMatch2 = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i
  );

  return (ogMatch?.[1] || ogMatch2?.[1] || metaMatch?.[1] || metaMatch2?.[1] || "").substring(0, CONFIG.META_DESC_MAX_CHARS);
}

/**
 * Extract JSON-LD structured data (NewsArticle, Article, BlogPosting).
 * Most modern sites (including Next.js/React) embed this in <head>.
 */
function extractJsonLdDescription(html) {
  const ldRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = ldRegex.exec(html)) !== null) {
    try {
      let data = JSON.parse(match[1]);
      // Handle @graph arrays (some sites wrap multiple schemas)
      if (data["@graph"]) data = data["@graph"];
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const type = (item["@type"] || "").toLowerCase();
        if (type.includes("article") || type.includes("newsarticle") || type.includes("blogposting") || type.includes("reportage")) {
          // Prefer articleBody (full text), fall back to description
          const body = item.articleBody || "";
          const desc = item.description || "";
          const text = body.length > desc.length ? body : desc;
          if (text) return decodeEntities(text).substring(0, CONFIG.JSONLD_MAX_CHARS);
        }
      }
    } catch {
      // invalid JSON, try next block
    }
  }
  return "";
}

/**
 * Extract rich context from HTML using multiple strategies:
 * 1. JSON-LD structured data (most reliable, used by modern sites)
 * 2. Meta description (og:description)
 * 3. Article body <p> tags (fallback for traditional CMS sites)
 * Returns up to CONFIG.CONTEXT_MAX_CHARS characters of combined context.
 */
function extractContext(html) {
  // Strategy 1: JSON-LD (best source — structured, contains specific names)
  const jsonLdDesc = extractJsonLdDescription(html);

  // Strategy 2: meta description
  const metaDesc = extractMetaDescription(html);

  // Strategy 3: article body <p> tags
  let bodyText = "";
  // Strip noise blocks before paragraph extraction
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");

  // Try to find article container (multiple strategies)
  const articleMatch = cleaned.match(
    /<(?:article|div)[^>]*(?:class|id)=["'][^"']*(?:article|story|post|entry|content)[-_]?(?:body|content|text|area)[^"']*["'][^>]*>([\s\S]*)/i
  ) || cleaned.match(
    /<article[^>]*>([\s\S]*)/i  // fallback: any <article> tag (bright.nl uses <article role="main">)
  );
  const region = articleMatch ? articleMatch[0] : cleaned;

  const paragraphs = [];
  let totalLen = 0;
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRegex.exec(region)) !== null && totalLen < CONFIG.PARAGRAPH_MAX_CHARS) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, ""));
    if (text.length < CONFIG.MIN_PARAGRAPH_LENGTH) continue;
    paragraphs.push(text);
    totalLen += text.length;
  }
  bodyText = paragraphs.join(" ");

  // Combine: pick the richest context available
  const best = jsonLdDesc || bodyText || "";
  const extra = metaDesc && metaDesc !== best ? metaDesc : "";

  if (best && extra) {
    return `${best} | ${extra}`.substring(0, CONFIG.CONTEXT_MAX_CHARS);
  }
  return (best || extra || "").substring(0, CONFIG.CONTEXT_MAX_CHARS);
}

/**
 * Build the shared prompt parts used by all providers.
 */
function buildPrompts(headlines, mode = "news", lang = "auto") {
  const headlineList = headlines
    .map((h) => {
      let line = `- id: "${h.id}" | kop: "${h.text}"`;
      if (h.context) {
        line += ` | context: "${h.context}"`;
      }
      return line;
    })
    .join("\n");

  let systemPrompt;
  if (mode === "youtube") {
    systemPrompt = `You are an editor evaluating and rewriting YouTube video titles.

Rules:
- Assess if the title is clickbait. YouTube clickbait often uses: ALL CAPS words, excessive emoji, vague promises ("you won't believe..."), emotional manipulation, exaggerated claims, or intentionally withheld key information.
- If the title is already informative and specific enough, return "newTitle": null. NOT everything needs rewriting. A title like "I made $10,000 from a vibecoded app" is already specific enough — leave it.
- Only rewrite titles that are genuinely misleading, vague, or use manipulative tactics.
- CRITICAL: NEVER translate the title. The rewritten title MUST be in the EXACT SAME language as the original. If the original is in Dutch, write Dutch. If in English, write English. If in German, write German. This is the most important rule — violating it ruins the user experience.
- If the title uses ALL CAPS for emphasis (like "TIKKIE heeft mijn VRIENDSCHAP VERPEST"), rewrite it in normal case but keep the same language.
- Even when the transcript is in a different language than the title, ALWAYS match the language of the ORIGINAL TITLE, not the transcript.
- IMPORTANT: Always include specific names, products, companies, or people mentioned in the transcript context. Replace vague references with actual names.
- Use the transcript context to make the title accurate and specific.
- Keep titles concise (max 80 characters).
- No opinions or editorial tone.
- Return ONLY valid JSON, no other text.${lang !== "auto" ? `\n- OVERRIDE: Write ALL rewritten titles in ${LANGUAGE_INSTRUCTIONS[lang]?.replace(/^Always write in /, "").replace(/, regardless.*$/, "") || lang}. This overrides the "same language" rule.` : ""}`;
  } else {
    systemPrompt = `Je bent een redacteur die clickbait-koppen herschrijft naar informatieve titels.

WANNEER HERSCHRIJVEN:
Een kop is clickbait als die bewust informatie achterhoudt om klikken te genereren. Signalen:
- Vage verwijzingen: "dit apparaat", "deze app", "het bedrijf", "een nieuwe functie"
- Nieuwsgierigheid-trucs: "hiermee kun je...", "zo doe je...", "dit is waarom...", "daarom moet je..."
- Essentieel onderwerp ontbreekt: de lezer kan niet inschatten waar het artikel over gaat
Als de kop al duidelijk genoeg is om te beslissen of je het wil lezen → "newTitle": null.

HOE HERSCHRIJVEN:
1. Zoek in de context naar: merknaam, productnaam, persoonsnaam, bedrijfsnaam, app-naam, boektitel, filmnaam
2. Zet het belangrijkste specifieke woord (naam/merk/product) vooraan in de titel
3. Voeg het kernfeit toe: wat gebeurt er, wat doet het, wat is de conclusie?

VOORBEELDEN:
- "Hiermee kan je overal online werken zonder stopcontact" + context bevat "Starlink Mini" en "PeakDo LinkPower 2"
  → "PeakDo LinkPower 2: draagbare batterij voor Starlink Mini"
- "Dit boek zal nooit verschijnen" + context bevat "Shy Girl" en "Mia Ballard"
  → "Shy Girl van Mia Ballard niet uitgebracht wegens AI-verdenking"
- "Review: dit laserapparaat is verrassend goed" + context bevat "LaserPecker LX2"
  → "LaserPecker LX2 review: betaalbaar laserapparaat voor thuis"
- "Samsung komt met nieuwe telefoon" (al specifiek genoeg)
  → null

REGELS:
- Maximaal ${CONFIG.MAX_TITLE_LENGTH} tekens
- KRITIEK: Behoud ALTIJD de taal van de originele kop. Vertaal NOOIT. Een Nederlandse kop moet Nederlands blijven, een Engelse kop moet Engels blijven. Dit is de belangrijkste regel
- Geen meningen of editoriale toon
- Retourneer ALLEEN valide JSON, geen andere tekst${lang !== "auto" ? `\n- OVERSCHRIJF: Schrijf ALLE herschreven titels in het ${{"nl":"Nederlands","en":"Engels","de":"Duits","fr":"Frans","es":"Spaans"}[lang] || lang}. Dit overschrijft de "zelfde taal" regel.` : ""}`;
  }

  const userPrompt = mode === "youtube"
    ? `Evaluate and rewrite these YouTube titles. Return a JSON array with "id" and "newTitle" (null if the title is already good).

IMPORTANT: Each rewritten title MUST be in the EXACT SAME language as the original title. A Dutch title must stay Dutch. An English title must stay English. A German title must stay German. NEVER translate to a different language.

Titles:
${headlineList}

Format: [{"id": "headline-0", "newTitle": "..." or null}, ...]`
    : `Beoordeel en herschrijf deze koppen. Retourneer een JSON array met "id" en "newTitle" (null als de kop al goed is).

Koppen:
${headlineList}

Format: [{"id": "headline-0", "newTitle": "..." of null}, ...]`;

  return { systemPrompt, userPrompt };
}

/**
 * Shared SSE stream parser used by Claude and OpenAI.
 * Reads SSE events, accumulates text via extractDelta, parses partial results
 * and sends them to the content script progressively.
 * Returns the full array of parsed results.
 */
async function readSSEStream(response, extractDelta, tabId, streamAction = "stream-result") {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  const sentResults = new Set();
  const allResults = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;

      try {
        const event = JSON.parse(data);
        const delta = extractDelta(event);
        if (delta) {
          fullText += delta;

          // Try to extract complete JSON objects as they appear
          const newResults = tryParsePartialResults(fullText, sentResults);
          for (const result of newResults) {
            allResults.push(result);
            sentResults.add(result.id);

            // Send to content script immediately for progressive rendering
            if (tabId) {
              chrome.tabs.sendMessage(tabId, {
                action: streamAction,
                result,
              }).catch(() => {}); // ignore if tab closed
            }
          }
        }
      } catch {
        // not valid JSON yet, continue
      }
    }
  }

  // Final parse of complete text (catch anything missed during streaming)
  try {
    const jsonStr = fullText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(jsonStr);
    const validated = validateResults(parsed);
    for (const result of validated) {
      if (!sentResults.has(result.id)) {
        allResults.push(result);
      }
    }
  } catch {
    // If final parse fails but we got stream results, use those
  }

  return allResults;
}

/**
 * Call Claude API with streaming.
 */
async function callClaudeStreaming(apiKey, headlines, tabId, mode = "news", streamAction = "stream-result", lang = "auto") {
  // Safari: batch mode (non-streaming) in small batches to avoid SW timeout
  // and unreliable SSE streaming in Safari's service worker.
  if (IS_SAFARI) {
    return callClaudeBatched(apiKey, headlines, tabId, mode, streamAction, lang);
  }

  const { systemPrompt, userPrompt } = buildPrompts(headlines, mode, lang);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: CONFIG.CLAUDE_MAX_TOKENS,
        stream: true,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return { error: "Ongeldige API key. Controleer je key in de instellingen." };
      }
      if (response.status === 429) {
        return { error: "Rate limit bereikt. Probeer het over een minuut opnieuw." };
      }
      return {
        error: `API fout (${response.status}): ${err.error?.message || "Onbekende fout"}`,
      };
    }

    const extractDelta = (event) =>
      event.type === "content_block_delta" ? event.delta?.text : null;
    const allResults = await readSSEStream(response, extractDelta, tabId, streamAction);
    return { results: allResults };
  } catch (err) {
    return { error: `Fout: ${err.message}` };
  }
}

/**
 * Safari-specific: process Claude in small non-streaming batches.
 * Each batch completes quickly enough to avoid SW termination, and avoids
 * SSE streaming via ReadableStream which is unreliable in Safari's SW.
 */
async function callClaudeBatched(apiKey, headlines, tabId, mode = "news", streamAction = "stream-result", lang = "auto") {
  const BATCH_SIZE = 8;
  const allResults = [];

  for (let i = 0; i < headlines.length; i += BATCH_SIZE) {
    const batch = headlines.slice(i, i + BATCH_SIZE);
    const { systemPrompt, userPrompt } = buildPrompts(batch, mode, lang);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: CONFIG.CLAUDE_MAX_TOKENS,
          stream: false,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (response.status === 401) return { error: "Invalid API key. Check your key in settings." };
        if (response.status === 429) return { error: "Rate limit reached. Try again in a minute." };
        return { error: `API error (${response.status}): ${err.error?.message || "Unknown error"}` };
      }

      const data = await response.json();
      // Claude returns content as an array of blocks; join all text blocks.
      const text = (data.content || []).map((b) => b?.text || "").join("");
      try {
        const results = parseAndSendResults(text, tabId, streamAction);
        allResults.push(...results);
      } catch {
        // Skip unparseable batch
      }
    } catch (err) {
      return { error: `Error: ${err.message}` };
    }
  }

  return { results: allResults };
}

/**
 * Try to extract complete {"id": "...", "newTitle": "..."} objects from
 * partial JSON text as it streams in.
 */
function tryParsePartialResults(text, alreadySent) {
  const results = [];
  // Match complete JSON objects for headline results
  const regex = /\{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"newTitle"\s*:\s*(null|"(?:[^"\\]|\\.)*")\s*\}/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const id = match[1];
    if (alreadySent.has(id)) continue;

    const rawTitle = match[2];
    const newTitle = rawTitle === "null" ? null : JSON.parse(rawTitle);
    results.push({ id, newTitle });
  }

  return results;
}

/**
 * Parse a non-streaming JSON response and send results to content script.
 */
function parseAndSendResults(text, tabId, streamAction = "stream-result") {
  let jsonStr = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to salvage truncated JSON: find last complete object and close the array
    const lastComplete = jsonStr.lastIndexOf("}");
    if (lastComplete > 0) {
      const salvaged = jsonStr.substring(0, lastComplete + 1) + "]";
      try {
        parsed = JSON.parse(salvaged);
        console.debug(`[Unbait] Salvaged truncated JSON (${parsed.length} results)`);
      } catch {
        throw new Error("Unexpected end of JSON input");
      }
    } else {
      throw new Error("Unexpected end of JSON input");
    }
  }

  const validated = validateResults(parsed);

  for (const result of validated) {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: streamAction,
        result,
      }).catch(() => {});
    }
  }

  return validated;
}

/**
 * Call OpenAI API (GPT-4o mini) with streaming.
 */
async function callOpenAI(apiKey, headlines, tabId, mode = "news", streamAction = "stream-result", lang = "auto") {
  // Safari: batch mode (non-streaming) in small batches to avoid SW timeout
  if (IS_SAFARI) {
    return callOpenAIBatched(apiKey, headlines, tabId, mode, streamAction, lang);
  }

  // Chrome: streaming mode for best UX
  const { systemPrompt, userPrompt } = buildPrompts(headlines, mode, lang);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 401) return { error: "Invalid OpenAI API key." };
      if (response.status === 429) return { error: "Rate limit reached. Try again in a minute." };
      return { error: `OpenAI error (${response.status}): ${err.error?.message || "Unknown error"}` };
    }

    const extractDelta = (event) =>
      event.choices?.[0]?.delta?.content || null;
    const allResults = await readSSEStream(response, extractDelta, tabId, streamAction);

    if (allResults.length === 0) {
      return { error: "Failed to parse OpenAI response." };
    }

    return { results: allResults };
  } catch (err) {
    return { error: `OpenAI error: ${err.message}` };
  }
}

/**
 * Safari-specific: process OpenAI in small non-streaming batches.
 * Each batch completes quickly enough to avoid SW termination.
 */
async function callOpenAIBatched(apiKey, headlines, tabId, mode = "news", streamAction = "stream-result", lang = "auto") {
  const BATCH_SIZE = 8;
  const allResults = [];

  for (let i = 0; i < headlines.length; i += BATCH_SIZE) {
    const batch = headlines.slice(i, i + BATCH_SIZE);
    const { systemPrompt, userPrompt } = buildPrompts(batch, mode, lang);

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (response.status === 401) return { error: "Invalid OpenAI API key." };
        if (response.status === 429) return { error: "Rate limit reached. Try again in a minute." };
        return { error: `OpenAI error (${response.status}): ${err.error?.message || "Unknown error"}` };
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || "";
      try {
        const results = parseAndSendResults(text, tabId, streamAction);
        allResults.push(...results);
      } catch {
        // Skip unparseable batch
      }
    } catch (err) {
      return { error: `OpenAI error: ${err.message}` };
    }
  }

  return { results: allResults };
}

/**
 * Make a single Gemini API request and return the result.
 * Returns { ok, data, error, status }.
 */
async function callGeminiSingleRequest(apiKey, systemPrompt, userPrompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: CONFIG.GEMINI_MAX_TOKENS,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    return { ok: false, data: null, error: err, status: response.status };
  }

  const data = await response.json();
  return { ok: true, data, error: null, status: response.status };
}

/**
 * Call Google Gemini API (Gemini 2.5 Flash).
 * Splits headlines into small batches to stay within free tier token limits.
 */
async function callGemini(apiKey, headlines, tabId, mode = "news", streamAction = "stream-result", lang = "auto") {
  const allResults = [];
  console.debug(`[Unbait] Gemini: processing ${headlines.length} headlines in ${Math.ceil(headlines.length / CONFIG.GEMINI_BATCH_SIZE)} batches`);

  for (let i = 0; i < headlines.length; i += CONFIG.GEMINI_BATCH_SIZE) {
    const batch = headlines.slice(i, i + CONFIG.GEMINI_BATCH_SIZE);
    const { systemPrompt, userPrompt } = buildPrompts(batch, mode, lang);

    // Wait between batches (not before the first one)
    if (i > 0) await new Promise((r) => setTimeout(r, CONFIG.GEMINI_BATCH_DELAY_MS));

    let retries = 0;
    let batchDone = false;

    while (!batchDone && retries <= CONFIG.GEMINI_MAX_RETRIES) {
      try {
        const { ok, data, error: err, status } = await callGeminiSingleRequest(apiKey, systemPrompt, userPrompt);

        if (!ok) {
          if (status === 429 && retries < CONFIG.GEMINI_MAX_RETRIES) {
            retries++;
            const errMsg = err?.error?.message || "unknown";
            const wait = CONFIG.GEMINI_RETRY_BASE_MS * retries;
            console.debug(`[Unbait] Gemini 429: "${errMsg}" — retry ${retries}/${CONFIG.GEMINI_MAX_RETRIES} in ${wait/1000}s...`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          if (status === 429) {
            const errMsg = err?.error?.message || "unknown";
            console.warn(`[Unbait] Gemini rate limit exceeded: "${errMsg}"`);
            if (errMsg.includes("per_day") || errMsg.includes("RPD") || errMsg.includes("limit: 0")) {
              return { error: "Gemini daily limit reached (20 requests/day on free tier). Try again tomorrow or switch to Anthropic/OpenAI." };
            }
            batchDone = true;
            continue;
          }
          if (status === 400) return { error: "Invalid Gemini API key." };
          return { error: `Gemini error (${status}): ${err?.error?.message || "Unknown error"}` };
        }


        // Check for safety blocks or empty responses
        const finishReason = data.candidates?.[0]?.finishReason;
        if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
          console.warn(`[Unbait] Gemini blocked batch (reason: ${finishReason}), skipping`);
          batchDone = true;
          continue;
        }

        // Gemini 2.5 Flash may return multiple parts (thinking + response)
        // Find the last text part, which contains the actual JSON output
        const parts = data.candidates?.[0]?.content?.parts || [];
        let text = "";
        for (const part of parts) {
          if (part.text) text = part.text; // take the last text part
        }

        if (!text) {
          console.warn("[Unbait] Gemini returned empty response, parts:", JSON.stringify(parts).substring(0, 300));
          batchDone = true;
          continue;
        }


        try {
          const results = parseAndSendResults(text, tabId, streamAction);
          allResults.push(...results);
        } catch (parseErr) {
          console.error("[Unbait] Failed to parse Gemini response:", parseErr.message);
        }

        batchDone = true;
      } catch (err) {
        return { error: `Gemini error: ${err.message}` };
      }
    }
  }

  return { results: allResults };
}

// ---------------------------------------------------------------------------
// Gist: Summarize article/video (AI summary with verdict)
// ---------------------------------------------------------------------------

const GIST_CONFIG = {
  CLAUDE_MAX_TOKENS: 1024,
  OPENAI_MAX_TOKENS: 1024,
  GEMINI_MAX_TOKENS: 2048,
};

const LANGUAGE_INSTRUCTIONS = {
  auto: "Write in the same language as the content. Dutch article → Dutch. English → English.",
  nl: "Always write in Dutch (Nederlands), regardless of the content's language.",
  en: "Always write in English, regardless of the content's language.",
  de: "Always write in German (Deutsch), regardless of the content's language.",
  fr: "Always write in French (Français), regardless of the content's language.",
  es: "Always write in Spanish (Español), regardless of the content's language.",
};

const VERDICT_LABELS = {
  auto: '🟢 **Watch** or 🟢 **Read** (adapt label to content language), 🟡 **Optional**, 🔴 **Skip**',
  nl: '🟢 **Bekijken** or 🟢 **Lezen**, 🟡 **Optioneel**, 🔴 **Overslaan**',
  en: '🟢 **Watch** or 🟢 **Read**, 🟡 **Optional**, 🔴 **Skip**',
  de: '🟢 **Ansehen** or 🟢 **Lesen**, 🟡 **Optional**, 🔴 **Überspringen**',
  fr: '🟢 **Regarder** or 🟢 **Lire**, 🟡 **Optionnel**, 🔴 **Ignorer**',
  es: '🟢 **Ver** or 🟢 **Leer**, 🟡 **Opcional**, 🔴 **Omitir**',
};

async function buildSummaryPrompt(title, content) {
  const data = await chrome.storage.local.get("summaryLanguage");
  const lang = data.summaryLanguage || "auto";
  const langInstruction = LANGUAGE_INSTRUCTIONS[lang] || LANGUAGE_INSTRUCTIONS.auto;
  const verdictLabels = VERDICT_LABELS[lang] || VERDICT_LABELS.auto;

  const titleOnlyExtra = content
    ? ""
    : `\n- You only have the title — no transcript or article text. Give your best verdict based on the title alone. Do NOT mention the lack of content or transcript. Just judge it.`;

  const systemPrompt = `You are an assistant that evaluates and summarizes articles and videos. Give a "gist" — a short, honest verdict on whether something is worth your time.

FORMAT (follow exactly):
1. First line: verdict emoji + bold label + short reason
   - Use exactly one of: ${verdictLabels}
   - Followed by " | " and a short reason (e.g. entertaining, informative, just a press release)
2. Empty line, then 1–3 sentences summarizing what this is likely about, based on the title and content.
3. Empty line, then "**Key points:** " followed by (1), (2), etc. — the most important facts or likely takeaways. If the content includes timestamp markers like [1:23], add the timestamp after the key point in parentheses, e.g. "(1) The main argument is X (2:14)".

RULES:
- ${langInstruction}
- Be honest and direct. If it's clickbait or adds little value, say so.
- Content that mainly repeats a press release or lacks analysis → 🔴 Skip
- Content that is entertaining, funny, or surprising → 🟢 Watch/Read
- Content that has useful info but isn't essential → 🟡 Optional
- Start DIRECTLY with the verdict. No intro phrases.
- Keep it short: max 150 words total.${titleOnlyExtra}`;

  const userPrompt = content
    ? `Title: "${title}"\nContent: "${content.substring(0, 10000)}"\n\nGive the gist.`
    : `Title: "${title}"\n\nGive the gist.`;

  return { systemPrompt, userPrompt };
}

async function handleSummarizeArticle(message, tabId) {
  try {
    const { url, title, context } = message;
    let articleContext = context || "";
    if (!articleContext && url) articleContext = await fetchArticleContext(url);
    const hasContent = !!articleContext;

    const data = await chrome.storage.local.get(["provider", "apiKey_anthropic", "apiKey_openai", "apiKey_gemini"]);
    const provider = data.provider || "anthropic";
    const apiKey = data[`apiKey_${provider}`];
    if (!apiKey) { sendGistResult(tabId, url, { error: "No API key set. Open the Unbait popup.", hasContent }); return; }

    const { systemPrompt, userPrompt } = await buildSummaryPrompt(title, articleContext || null);
    const result = await callProviderForSummary(provider, apiKey, systemPrompt, userPrompt, tabId, url);
    sendGistResult(tabId, url, { ...result, hasContent });
  } catch (err) {
    sendGistResult(tabId, message.url, { error: err.message, hasContent: false });
  }
}

async function handleSummarizeYouTube(message, tabId) {
  try {
    const { url, title, transcript } = message;
    const hasTranscript = !!transcript;

    const data = await chrome.storage.local.get(["provider", "apiKey_anthropic", "apiKey_openai", "apiKey_gemini"]);
    const provider = data.provider || "anthropic";
    const apiKey = data[`apiKey_${provider}`];
    if (!apiKey) { sendGistResult(tabId, url, { error: "No API key set. Open the Unbait popup.", hasTranscript }); return; }

    const { systemPrompt, userPrompt } = await buildSummaryPrompt(title, transcript || null);
    const result = await callProviderForSummary(provider, apiKey, systemPrompt, userPrompt, tabId, url);
    sendGistResult(tabId, url, { ...result, hasTranscript });
  } catch (err) {
    sendGistResult(tabId, message.url, { error: err.message, hasTranscript: false });
  }
}

function sendGistResult(tabId, url, result) {
  if (!tabId) return;
  if (result && result.summary && !result.error) incrementStats("totalGists", 1);
  chrome.tabs.sendMessage(tabId, { action: "gist-result", url, ...result }).catch(() => {});
}

function sendGistStreamChunk(tabId, url, text) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { action: "gist-stream", url, text }).catch(() => {});
}

async function _fetchHtml(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.CONTEXT_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, { signal: controller.signal, credentials: "omit", referrer: "" });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      // CORS/permission failures throw a generic TypeError. Distinguish by
      // checking whether host_permission for this origin was granted.
      try {
        const origin = new URL(url).origin + "/*";
        const has = await chrome.permissions.contains({ origins: [origin] });
        if (!has) {
          console.warn(`[Unbait] fetch blocked — no host permission for ${origin}. Toggle Gist off/on or grant in popup.`);
          return "";
        }
      } catch { /* ignore */ }
      throw fetchErr;
    }
    clearTimeout(timeoutId);
    if (!resp.ok) {
      console.debug(`[Unbait] _fetchHtml: ${url} → HTTP ${resp.status}`);
      return "";
    }
    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/xml") && !contentType.includes("application/xhtml")) {
      console.debug(`[Unbait] _fetchHtml: ${url} → non-html content-type: ${contentType}`);
      return "";
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let bytesRead = 0;
    while (bytesRead < CONFIG.CONTEXT_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytesRead += value.length;
    }
    reader.cancel();
    return html;
  } catch (err) {
    console.debug(`[Unbait] _fetchHtml: ${url} → exception: ${err.message}`);
    return "";
  }
}

// Minimum chars below which we treat the page as an interstitial/thin page
// and look for a hop target to the real article.
const MIN_CONTEXT_CHARS = 500;

/**
 * Detect hop target in raw HTML for interstitial/click-through pages.
 * Returns a different-site absolute URL or null. Works for meta-refresh,
 * canonical, continue-style anchor text, and inline JSON blobs that
 * aggregators (NewsNow, Nuxt/Vue SSR) embed.
 */
function _findHopTarget(html, baseUrl) {
  let baseHost;
  try { baseHost = new URL(baseUrl).hostname; } catch { return null; }
  const baseRoot = baseHost.split(".").slice(-2).join(".");
  const resolve = (href) => {
    try { return new URL(href, baseUrl).href; } catch { return null; }
  };
  const isDifferentSite = (absolute) => {
    try {
      const h = new URL(absolute).hostname;
      const hRoot = h.split(".").slice(-2).join(".");
      return hRoot !== baseRoot;
    } catch { return false; }
  };

  // Pattern 1: meta refresh with URL
  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)/i);
  if (meta) {
    const abs = resolve(meta[1]);
    if (abs && isDifferentSite(abs) && /^https?:/i.test(abs)) {
      console.debug(`[Unbait] hop p1 (meta-refresh): ${abs}`);
      return abs;
    }
  }

  // Pattern 2: cross-site canonical link
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  if (canonical) {
    const abs = resolve(canonical[1]);
    if (abs && isDifferentSite(abs) && /^https?:/i.test(abs)) {
      console.debug(`[Unbait] hop p2 (canonical): ${abs}`);
      return abs;
    }
  }

  // Pattern 3: "continue to article" / "lees verder" / "here" link
  const continueRe = /\b(continue to article|continue|read (?:full|more|the full|original)|original article|lees verder|ga verder|volledig artikel|here|klik hier)\b/i;
  const linkMatches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const m of linkMatches) {
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (!continueRe.test(text)) continue;
    const abs = resolve(m[1]);
    if (abs && isDifferentSite(abs) && /^https?:/i.test(abs)) {
      console.debug(`[Unbait] hop p3 (continue-link "${text.slice(0, 40)}"): ${abs}`);
      return abs;
    }
  }

  // Pattern 4: inline JSON blob with a url field (Vue/Nuxt SSR, e.g. NewsNow's
  // __INITIAL_STATE__.page.clickthroughPageData.url).
  const jsonUrlRe = /"(?:url|targetUrl|articleUrl|destinationUrl|finalUrl|redirectUrl)"\s*:\s*"((?:https?:|https?:\\?\/\\?\/)[^"]+)"/gi;
  let jm;
  while ((jm = jsonUrlRe.exec(html)) !== null) {
    let candidate = jm[1]
      .replace(/\\u002[fF]/g, "/")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&");
    const abs = resolve(candidate);
    if (abs && isDifferentSite(abs) && /^https?:\/\//i.test(abs)) {
      console.debug(`[Unbait] hop p4 (inline JSON url field): ${abs}`);
      return abs;
    }
  }

  // Pattern 5: ?url=<encoded> query parameter embedded anywhere (e.g. in a
  // form action or Vue router path). NewsNow's frozenPageString encodes the
  // destination this way as `?url=https%3A%2F%2F...`.
  const qpMatches = html.matchAll(/[?&]url=(https?%3A%2F%2F[^"'&\s<>]+)/gi);
  for (const qm of qpMatches) {
    try {
      const decoded = decodeURIComponent(qm[1]);
      const abs = resolve(decoded);
      if (abs && isDifferentSite(abs) && /^https?:\/\//i.test(abs)) {
        console.debug(`[Unbait] hop p5 (?url= param): ${abs}`);
        return abs;
      }
    } catch { /* malformed encoding, try next */ }
  }

  return null;
}

async function fetchArticleContext(url, hopCount = 0) {
  const html = await _fetchHtml(url);
  if (!html) {
    console.debug("[Unbait] fetchArticleContext: empty html for", url);
    return "";
  }
  const context = extractContext(html);
  console.debug(`[Unbait] fetchArticleContext: ${url} → ${context.length} chars (hop=${hopCount}, htmlSize=${html.length})`);

  // Thin page → try one hop to the real article.
  if (context.length < MIN_CONTEXT_CHARS && hopCount < 1) {
    const hopUrl = _findHopTarget(html, url);
    if (hopUrl) {
      console.debug(`[Unbait] interstitial hop: ${url} → ${hopUrl}`);
      const hopContext = await fetchArticleContext(hopUrl, hopCount + 1);
      if (hopContext.length > context.length) return hopContext;
    } else {
      console.debug(`[Unbait] no hop target found in thin page ${url}`);
    }
  }

  return context;
}

async function callProviderForSummary(provider, apiKey, systemPrompt, userPrompt, tabId, url) {
  switch (provider) {
    case "openai": return await callOpenAIForSummary(apiKey, systemPrompt, userPrompt, tabId, url);
    case "gemini": return await callGeminiForSummary(apiKey, systemPrompt, userPrompt, tabId, url);
    case "anthropic":
    default: return await callClaudeForSummary(apiKey, systemPrompt, userPrompt, tabId, url);
  }
}

async function callClaudeForSummary(apiKey, systemPrompt, userPrompt, tabId, url) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey, "anthropic-version": "2023-06-01",
        "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: GIST_CONFIG.CLAUDE_MAX_TOKENS,
        // Safari: non-streaming — SSE via ReadableStream is unreliable in SW
        stream: !IS_SAFARI,
        system: systemPrompt, messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 401) return { error: "Invalid API key." };
      if (response.status === 429) return { error: "Rate limit reached. Try again later." };
      return { error: `API error (${response.status}): ${err.error?.message || "Unknown error"}` };
    }
    if (IS_SAFARI) {
      const data = await response.json();
      const text = (data.content || []).map((b) => b?.text || "").join("");
      if (!text) return { error: "Empty response from Claude." };
      sendGistStreamChunk(tabId, url, text);
      return { summary: text };
    }
    return await readSSEStreamText(response, (event) =>
      event.type === "content_block_delta" ? event.delta?.text : null, tabId, url);
  } catch (err) { return { error: `Error: ${err.message}` }; }
}

async function callOpenAIForSummary(apiKey, systemPrompt, userPrompt, tabId, url) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // Safari: non-streaming — SSE via ReadableStream is unreliable in SW
        model: "gpt-4o-mini", stream: !IS_SAFARI, temperature: 0.3,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 401) return { error: "Invalid OpenAI API key." };
      if (response.status === 429) return { error: "Rate limit reached." };
      return { error: `OpenAI error (${response.status}): ${err.error?.message || "Unknown error"}` };
    }
    if (IS_SAFARI) {
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || "";
      if (!text) return { error: "Empty response from OpenAI." };
      sendGistStreamChunk(tabId, url, text);
      return { summary: text };
    }
    return await readSSEStreamText(response, (event) =>
      event.choices?.[0]?.delta?.content || null, tabId, url);
  } catch (err) { return { error: `OpenAI error: ${err.message}` }; }
}

async function callGeminiForSummary(apiKey, systemPrompt, userPrompt, tabId, url) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: GIST_CONFIG.GEMINI_MAX_TOKENS },
        }),
      }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 400) return { error: "Invalid Gemini API key." };
      if (response.status === 429) return { error: "Gemini rate limit reached." };
      return { error: `Gemini error (${response.status}): ${err?.error?.message || "Unknown error"}` };
    }
    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    let text = "";
    for (const part of parts) { if (part.text) text = part.text; }
    if (!text) return { error: "Gemini returned an empty response." };
    sendGistStreamChunk(tabId, url, text);
    return { summary: text };
  } catch (err) { return { error: `Gemini error: ${err.message}` }; }
}

async function readSSEStreamText(response, extractDelta, tabId, url) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const d = line.slice(6);
      if (d === "[DONE]") continue;
      try {
        const event = JSON.parse(d);
        const delta = extractDelta(event);
        if (delta) { fullText += delta; sendGistStreamChunk(tabId, url, fullText); }
      } catch { /* not valid JSON yet */ }
    }
  }
  return { summary: fullText };
}
