// Run with: node scripts/test-firefox-permissions.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../extension/popup/popup.js"), "utf8");
function definition(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const prefix = source.slice(start - 6, start) === "async " ? "async " : "";
  return prefix + source.slice(start, source.indexOf("\n}", start) + 2);
}

async function check(entry, permission) {
  const events = [];
  let handler;
  const context = vm.createContext({
    URL,
    _currentHostname: "example.com",
    addSiteInput: { value: "https://example.com/news" },
    alwaysGistToggle: {
      checked: true,
      addEventListener: (_event, fn) => { handler = fn; },
    },
    getSiteMode: async () => { events.push("read"); return "off"; },
    getAutoSites: async () => { events.push("read"); return []; },
    saveAutoSites: async () => events.push("save"),
    paintSiteMode: () => {},
    refreshAlwaysGistUI: () => {},
    chrome: {
      permissions: { request: async () => {
        events.push("request");
        if (permission === "error") throw new Error("Permission request failed");
        return permission;
      } },
      tabs: { query: async () => [{ id: 1 }] },
      runtime: { sendMessage: async () => events.push("save") },
      storage: { local: { set: async () => events.push("save") } },
    },
  });
  for (const name of ["originsForHostname", "requestSitePermission", "setCurrentSiteMode", "addSiteManually"]) {
    vm.runInContext(definition(name), context);
  }
  const start = source.indexOf('alwaysGistToggle.addEventListener("change"');
  vm.runInContext(source.slice(start, source.indexOf("\n});", start) + 4), context);
  const pending = entry === "gist" ? handler() : vm.runInContext(entry, context);
  assert.deepEqual(events, ["request"], `${entry}: request must happen before yielding`);
  await pending;
  assert.equal(events.includes("save"), permission === true, `${entry}: save only on grant`);
  if (entry === "gist") assert.equal(context.alwaysGistToggle.checked, permission === true);
}

(async () => {
  for (const entry of ['setCurrentSiteMode("full")', 'setCurrentSiteMode("gist")', "addSiteManually()", "gist"]) {
    for (const result of [true, false, "error"]) await check(entry, result);
  }
  console.log("PASS: all permission entry points request synchronously and respect denial/errors");
})().catch(error => { console.error(error); process.exitCode = 1; });
