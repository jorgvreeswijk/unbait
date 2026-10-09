// Run with: node scripts/test-title-cache.js (no browser or API key required).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../extension");
const tick = () => new Promise(resolve => setImmediate(resolve));

async function check() {
  const stored = { provider: "openai", apiKey_openai: "test-only", autoSites: [] };
  let updated;
  const injections = [];
  const storage = {
    get: async keys => {
      // Copy before yielding to reproduce concurrent read/modify/write races.
      const data = Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]]));
      const snapshot = structuredClone(data);
      await tick();
      return snapshot;
    },
    set: async data => { await tick(); Object.assign(stored, structuredClone(data)); },
    remove: async () => {},
  };
  const background = vm.createContext({
    URL, console, navigator: { userAgent: "Firefox" },
    chrome: {
      storage: { local: storage, sync: { get: async () => ({}) }, onChanged: { addListener() {} } },
      runtime: { id: "test", onMessage: { addListener() {} } },
      tabs: { onUpdated: { addListener: fn => { updated = fn; } } },
      scripting: {
        executeScript: async details => { injections.push(details); return []; },
        insertCSS: async () => {},
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, "background/service-worker.js"), "utf8"), background);

  const one = "https://www.upworthy.com/story-one/";
  const two = "https://www.geektime.co.il/story-two/";
  await Promise.all([
    background.saveTitleCache({ [one]: "First answer" }, "unbait_cache_", "openai"),
    background.saveTitleCache({ [two]: "Second answer" }, "unbait_cache_", "openai"),
  ]);
  assert.equal(Object.keys(stored.unbait_cache_openai).length, 2, "parallel tabs must not overwrite each other");
  await assert.rejects(background.saveTitleCache({}, "invalid", "openai"));

  // A final response without any streaming messages must be saved before done.
  background.callProvider = async () => ({ results: [{ id: "headline-0", newTitle: "The actual answer" }] });
  const result = await background.handleRewrite([
    { id: "headline-0", url: one, text: "Original teaser", context: "Available article context" },
  ], 7);
  assert.ok(!result.error, result.error);
  assert.equal(stored.unbait_cache_openai[one].newTitle, "The actual answer");
  assert.equal(stored.unbait_cache_openai[one].originalTitle, "Original teaser");
  assert.equal(stored.unbait_cache_openai[two].newTitle, "Second answer");
  await background.saveTitleCache({ [one]: "Different provider" }, "unbait_cache_", "gemini");
  assert.equal(stored.unbait_cache_openai[one].newTitle, "The actual answer");

  updated(7, { status: "complete" }, { url: "https://www.upworthy.com/" });
  for (let i = 0; i < 20 && injections.length === 0; i++) await tick();
  assert.ok(injections.some(item => item.files.includes("/content/content.js")), "refresh must inject cached-title restoration");

  const restored = [];
  const page = vm.createContext({
    _isRestoring: false,
    CONFIG: { CACHE_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000 },
    findHeadlines: () => [{ url: one, text: "Original teaser", element: { classList: { contains: () => false } } }],
    Unbait: { getCurrentProvider: async () => "openai" },
    getCache: async provider => stored[`unbait_cache_${provider}`],
    renderReplacedHeadline: (_el, title, original) => restored.push({ title, original }),
    injectGistIcons() {}, notifyBadgeCount() {}, console,
  });
  const source = fs.readFileSync(path.join(root, "content/content.js"), "utf8");
  const start = source.indexOf("async function restoreCachedTitles(");
  vm.runInContext(source.slice(start, source.indexOf("\n}", start) + 2), page);
  await page.restoreCachedTitles();
  assert.deepEqual(restored, [{ title: "The actual answer", original: "Original teaser" }]);
  console.log("PASS: parallel cache writes, final-result persistence, and refresh restoration without AI calls");
}
check().catch(error => { console.error(error); process.exitCode = 1; });
