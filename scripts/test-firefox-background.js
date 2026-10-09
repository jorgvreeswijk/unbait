// Run after building: node scripts/test-firefox-background.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "dist/firefox/manifest.json")));
assert.equal(manifest.background.service_worker, undefined);
assert.ok(manifest.browser_specific_settings.gecko.id);

async function boot(serviceWorker) {
  let onMessage;
  const registered = [];
  const store = {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
  };
  const context = vm.createContext({
    console,
    URL,
    navigator: { userAgent: serviceWorker ? "Chrome" : "Firefox" },
    chrome: {
      runtime: { id: "test", onMessage: { addListener: fn => { onMessage = fn; } } },
      storage: { local: store, sync: store, onChanged: { addListener() {} } },
      tabs: { onUpdated: { addListener() {} } },
      scripting: {
        getRegisteredContentScripts: async () => [],
        registerContentScripts: async scripts => registered.push(...scripts),
      },
    },
  });
  function run(file) {
    vm.runInContext(fs.readFileSync(path.join(root, "dist/firefox", file), "utf8"), context);
  }
  if (serviceWorker) {
    context.importScripts = file => run(path.posix.join("background", file));
    run("background/service-worker.js");
  } else {
    // Load in exactly the order Firefox will, with no importScripts global.
    for (const file of manifest.background.scripts) run(file);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof context.HtmlExtract.extractContext, "function");
  assert.equal(context.HtmlExtract.decodeEntities("one &amp; two"), "one & two");
  let reply = "no response";
  onMessage({ action: "get-status", tabId: 1 }, { id: "test" }, value => { reply = value; });
  assert.equal(reply, null, "background message listener must be ready");
  assert.ok(registered.some(script => script.id === "yt-main-bridge" && script.world === "MAIN"));
}

(async () => {
  await boot(false);
  await boot(true);
  console.log("PASS: Firefox event-page and Chrome/Safari service-worker startup");
})().catch(error => { console.error(error); process.exitCode = 1; });
