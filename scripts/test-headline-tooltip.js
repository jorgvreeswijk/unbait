// Run with: node scripts/test-headline-tooltip.js (no browser required).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(`${__dirname}/../extension/content/content.js`, "utf8");
function node(links = []) {
  const classes = new Set();
  return {
    dataset: {}, title: "", parentElement: null,
    classList: { contains: x => classes.has(x), add: x => classes.add(x), remove: x => classes.delete(x) },
    closest: () => null, querySelector: () => null,
    querySelectorAll: selector => selector === "a[href]" ? links : [],
    appendChild() {}, setAttribute() {},
  };
}
const page = vm.createContext({
  _state: { titles: new Map(), elements: new Map(), applied: new Set() },
  document: { createElement: () => node() },
  setTitleText: (el, text) => { el.textContent = text; },
  getIconTooltip: () => "Click to show original",
});
vm.runInContext(source.slice(source.indexOf("function renderReplacedHeadline("), source.indexOf("// ---------------------------------------------------------------------------", source.indexOf("function toggleTitle("))), page);
const url = "https://www.upworthy.com/example/";
const overlay = Object.assign(node(), { href: url });
const category = Object.assign(node(), { href: "https://www.upworthy.com/category/science/", title: "Science" });
const heading = node();
const content = node([category]);
const card = node([overlay, category]);
heading.parentElement = content;
content.parentElement = card;

// Cached restore passes the scanned URL even though the heading has no link.
page.renderReplacedHeadline(heading, "The answer", "Original teaser", url);
assert.equal(heading.dataset.unbaitUrl, url);
assert.equal(overlay.title, "Original: Original teaser");
assert.equal(heading.title, overlay.title);
assert.equal(category.title, "Science");
const icon = node();
page.toggleTitle(heading, icon);
assert.equal(overlay.title, "Unbait: The answer");
page.toggleTitle(heading, icon);
assert.equal(overlay.title, "Original: Original teaser");

// Fresh results use the URL retained during scanning/categorization.
page._state.elements.set("headline-0", heading);
page.applyResult({ id: "headline-0", newTitle: "Updated answer" });
assert.equal(overlay.title, "Original: Original teaser");
assert.equal(page._state.titles.get(url).rewritten, "Updated answer");

// Ordinary enclosing links and links inside a heading still receive tooltips.
const enclosing = Object.assign(node(), { href: url });
const nestedHeading = node();
nestedHeading.dataset.unbaitUrl = url;
nestedHeading.closest = () => enclosing;
page.setHeadlineTooltip(nestedHeading, "Original: Nested title");
assert.equal(enclosing.title, "Original: Nested title");
const inner = Object.assign(node(), { href: url });
const outerHeading = node([inner]);
outerHeading.dataset.unbaitUrl = url;
page.setHeadlineTooltip(outerHeading, "Original: Inner link");
assert.equal(inner.title, "Original: Inner link");
console.log("Headline tooltip checks passed (overlay, category, cached/fresh, toggle, nested links).");
