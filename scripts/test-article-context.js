// Run with: node scripts/test-article-context.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../extension");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, "content/html-utils.js"), "utf8"), context);
const extract = context.HtmlExtract.extractContext;

// Model an article after a large page header, with teaser-only JSON-LD and an
// answer beyond the introduction. These are synthetic fixture paragraphs.
const intro = "This introduction discusses motivation without identifying the practical questions to ask. ".repeat(15);
const answer = "The two questions are: why does this work matter, and who benefits from it?";
const html = `<script type="application/ld+json">${JSON.stringify({
  "@type": "NewsArticle", description: "An expert shares two surprising questions.",
})}</script><!--${"x".repeat(140000)}--><article><p>${intro}</p><p>${answer}</p></article>`;
for (const file of ["content/content.js", "background/service-worker.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const limit = Number(source.match(/CONTEXT_MAX_BYTES:\s*(\d+)/)[1]);
  assert.ok(extract(html.slice(0, limit)).includes(answer), `${file}: answer must reach the model`);
}
assert.equal(extract('<meta name="description" content="Metadata fallback">'), "Metadata fallback");
const body = "A detailed explanation of the result. ".repeat(250);
assert.equal(extract(`<article><p>${body}</p></article>`).length, 6000, "context remains bounded");
assert.ok(extract(`<script type="application/ld+json">${JSON.stringify({
  "@type": "Article", articleBody: answer,
})}</script>`).includes(answer), "structured article bodies remain usable");
console.log("PASS: full article beats teaser metadata, late answers survive, context stays bounded");
