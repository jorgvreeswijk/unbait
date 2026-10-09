// Run with: node scripts/test-scan-errors.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../extension/popup/popup.js"), "utf8");
const start = source.indexOf('btnDeclickbait.addEventListener("click"');
const handlerSource = source.slice(start, source.indexOf("\n});", start) + 4);

async function check(failure, expectedStep, hostname = "www.geektime.co.il") {
  let handler;
  const timers = new Set();
  const error = new Error("Missing host permission for the tab");
  const element = () => ({ textContent: "", classList: { add() {}, remove() {} } });
  const button = { ...element(), addEventListener: (_event, fn) => { handler = fn; } };
  const status = element();
  function checkPaths(files) {
    for (const file of files) {
      const resolved = new URL(file, "moz-extension://test/popup/popup.html");
      assert.ok(resolved.pathname.startsWith("/content/"), `Wrong injection path: ${resolved.pathname}`);
      assert.ok(fs.existsSync(path.join(__dirname, "../extension", resolved.pathname)));
    }
  }
  const context = vm.createContext({
    console: { error() {} },
    btnDeclickbait: button, statusEl: status, statsEl: element(),
    _currentHostname: hostname, YT_HOSTS: ["www.youtube.com"],
    updateDeclickbaitButton() {},
    setInterval: () => { timers.add(1); return 1; },
    setTimeout: (fn, ms) => {
      if (ms === 100) { queueMicrotask(fn); return 3; }
      timers.add(2); return 2;
    },
    clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id),
    chrome: {
      tabs: {
        query: async () => failure === "tab" ? [] : [{ id: 1 }],
        sendMessage: async () => {
          if (failure === "message") throw error;
          return failure === "response" ? { error: error.message } : { success: true };
        },
      },
      scripting: {
        executeScript: async ({ files }) => {
          checkPaths(files);
          if (failure === "script") throw error;
          return failure === "frame" ? [{ error }] : [{ frameId: 0 }];
        },
        insertCSS: async ({ files }) => {
          checkPaths(files);
          if (failure === "css") throw error;
        },
      },
    },
  });
  vm.runInContext(handlerSource, context);
  await handler();
  await new Promise(resolve => setImmediate(resolve));
  if (failure) {
    assert.ok(status.textContent.startsWith(`${expectedStep} failed:`), status.textContent);
    assert.ok(status.textContent.includes(failure === "tab" ? "No active tab" : error.message));
    assert.equal(button.disabled, false);
    assert.equal(timers.size, 0, "stop polling after an error");
  } else {
    assert.equal(button.disabled, true);
    assert.equal(timers.size, 2, "successful dispatch keeps status polling");
  }
}
(async () => {
  for (const [failure, step] of [
    ["tab", "Find active page"], ["script", "Load page scripts"],
    ["frame", "Load page scripts"], ["css", "Load page styles"],
    ["message", "Start page scan"], ["response", "Start page scan"], [null],
  ]) await check(failure, step);
  await check(null, null, "www.youtube.com");
  console.log("PASS: news/YouTube injection paths and scan error handling");
})().catch(error => { console.error(error); process.exitCode = 1; });
