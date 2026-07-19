// Shared HTML context-extraction utilities.
// Loaded in the service worker via importScripts('../content/html-utils.js')
// and injected before content.js in all non-YouTube content-script calls.

/* globals HtmlExtract */
if (typeof HtmlExtract === "undefined") {

var HtmlExtract = (function () {

  // These values mirror what both the service worker and content script used
  // independently. Unified here so changes only need to happen in one place.
  var META_DESC_MAX_CHARS = 300;
  var JSONLD_MAX_CHARS = 600;
  var PARAGRAPH_MAX_CHARS = 800;
  var MIN_PARAGRAPH_LENGTH = 40;
  var CONTEXT_MAX_CHARS = 800;

  function decodeEntities(str) {
    return str
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ").trim();
  }

  function extractMetaDescription(html) {
    const ogMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    return (ogMatch?.[1] || metaMatch?.[1] || "").substring(0, META_DESC_MAX_CHARS);
  }

  function extractJsonLd(html) {
    const ldRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = ldRegex.exec(html)) !== null) {
      try {
        let data = JSON.parse(match[1]);
        if (data["@graph"]) data = data["@graph"];
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const t = (item["@type"] || "").toLowerCase();
          if (t.includes("article") || t.includes("newsarticle") || t.includes("blogposting") || t.includes("reportage")) {
            const body = item.articleBody || "";
            const desc = item.description || "";
            const text = body.length > desc.length ? body : desc;
            if (text) return decodeEntities(text).substring(0, JSONLD_MAX_CHARS);
          }
        }
      } catch { /* invalid JSON-LD block, try next */ }
    }
    return "";
  }

  function extractContext(html) {
    const jsonLd = extractJsonLd(html);
    const metaDesc = extractMetaDescription(html);

    let cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<aside[\s\S]*?<\/aside>/gi, "");

    const articleMatch = cleaned.match(
      /<(?:article|div)[^>]*(?:class|id)=["'][^"']*(?:article|story|post|entry|content)[-_]?(?:body|content|text|area)[^"']*["'][^>]*>([\s\S]*)/i
    ) || cleaned.match(/<article[^>]*>([\s\S]*)/i);
    const region = articleMatch ? articleMatch[0] : cleaned;

    const paragraphs = [];
    let totalLen = 0;
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pm;
    while ((pm = pRe.exec(region)) !== null && totalLen < PARAGRAPH_MAX_CHARS) {
      const text = decodeEntities(pm[1].replace(/<[^>]+>/g, ""));
      if (text.length < MIN_PARAGRAPH_LENGTH) continue;
      paragraphs.push(text);
      totalLen += text.length;
    }
    const bodyText = paragraphs.join(" ");

    const best = jsonLd || bodyText || "";
    const extra = metaDesc && metaDesc !== best ? metaDesc : "";
    if (best && extra) return (best + " | " + extra).substring(0, CONTEXT_MAX_CHARS);
    return (best || extra || "").substring(0, CONTEXT_MAX_CHARS);
  }

  return { decodeEntities, extractMetaDescription, extractJsonLd, extractContext };
})();

} // end guard
