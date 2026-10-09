// Run with: node scripts/test-incremental-headlines.js (no network/API key).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const background = fs.readFileSync(`${__dirname}/../extension/background/service-worker.js`, "utf8");
const content = fs.readFileSync(`${__dirname}/../extension/content/content.js`, "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function load(source, name, context) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  vm.runInContext(source.slice(start, source.indexOf("\n}", start) + 2), context);
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function checkStream() {
  const sent = [];
  const context = vm.createContext({ TextDecoder, chrome: { tabs: {
    sendMessage: async (tab, message) => { sent.push({ tab, ...message }); },
  } } });
  for (const name of ["validateResults", "tryParsePartialResults", "readSSEStream"]) load(background, name, context);
  const first = { newTitle: 'תשובה עם "ציטוט" ו-{סוגריים}', id: "headline-0" };
  const second = { id: "headline-1", newTitle: null };
  const event = text => `data:${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
  // Split every byte, including Hebrew UTF-8 characters and the SSE envelope.
  const bytes = new TextEncoder().encode(event(`[${JSON.stringify(first)},`));
  const gate = deferred();
  let position = 0;
  const reader = { read: async () => {
    if (position < bytes.length) return { value: bytes.slice(position, ++position), done: false };
    if (position++ === bytes.length) {
      await gate.promise;
      return { value: new TextEncoder().encode(event(`${JSON.stringify(second)}]`) + "data: [DONE]"), done: false };
    }
    return { done: true };
  } };
  const pending = context.readSSEStream({ body: { getReader: () => reader } }, e => e.choices?.[0]?.delta?.content, 23);
  await tick();
  assert.equal(sent.length, 1, "first title must arrive before the second title/stream finishes");
  assert.equal(sent[0].result.newTitle, first.newTitle);
  assert.equal(sent[0].tab, 23);
  gate.resolve();
  const results = await pending;
  assert.equal(results.length, 2);
  assert.equal(sent.length, 2, "final parsing must not duplicate streamed titles");
  assert.equal(sent[1].result.newTitle, null);
}
async function checkBatches(failSecond = false) {
  const gate = deferred();
  const calls = [];
  const headlines = Array.from({ length: 12 }, (_, i) => ({ id: `headline-${i}`, url: `https://news.walla.co.il/item/${i}` }));
  const context = vm.createContext({
    CONFIG: { REWRITE_BATCH_SIZE: 5 },
    _state: { elements: new Map(), applied: new Set() },
    findHeadlines: () => headlines,
    injectGistIcons() {},
    Unbait: { getCurrentProvider: async () => "openai" },
    loadCache: async () => ({}),
    categorizeHeadlines: () => ({ uncachedData: headlines, cachedCount: 0 }),
    enrichHeadlinesWithContext: async batch => {
      calls.push(["context", batch.length]);
      if (calls.length === 3) await gate.promise;
      return batch;
    },
    fetchAndApplyResults: async (batch, provider, count, total, hasMore) => {
      calls.push(["rewrite", batch.length, hasMore]);
      if (failSecond && count === 5) return { error: "rate limit" };
      return { success: true, found: total, count: count + batch.length };
    },
  });
  load(content, "processHeadlines", context);
  const pending = context.processHeadlines();
  await tick();
  assert.deepEqual(calls, [["context", 5], ["rewrite", 5, true], ["context", 5]], "first group rewrites before remaining article context is ready");
  gate.resolve();
  const result = await pending;
  if (failSecond) {
    assert.equal(result.error, "rate limit");
    assert.equal(calls.length, 4, "stop additional API calls on provider error");
  } else {
    assert.equal(result.count, 12);
    assert.deepEqual(calls.slice(-2), [["context", 2], ["rewrite", 2, false]]);
  }
}
async function checkCompletion() {
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    console, document: { documentElement: { lang: "he" } },
    CONFIG: { API_TIMEOUT_MS: 120000 },
    _state: { elements: new Map(), applied: new Set(), isProcessing: true },
    chrome: { runtime: { sendMessage: async () => ({ accepted: true }) } },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    applyResult() {}, notifyBadgeCount() {}, handleGistStream() {}, handleGistResult() {},
  });
  load(content, "fetchAndApplyResults", context);
  const listenerStart = content.indexOf('chrome.runtime.onMessage.addListener(');
  let listener;
  context.chrome.runtime.onMessage = { addListener: fn => { listener = fn; } };
  vm.runInContext(content.slice(listenerStart, content.indexOf("\n});", listenerStart) + 4), context);
  const pending = context.fetchAndApplyResults([{ id: "headline-0" }], "openai", 0, 10, true);
  await tick();
  assert.equal(timers.size, 1);
  listener({ action: "rewrite-complete", result: { error: "rate limit" } });
  assert.equal((await pending).error, "rate limit");
  assert.equal(context._state.isProcessing, true, "batch completion must not release the page processing guard");
  assert.equal(timers.size, 0, "completed batch timer must not interfere with the next batch");
  const timedOut = context.fetchAndApplyResults([{ id: "headline-1" }], "openai", 0, 10);
  await tick();
  [...timers.values()][0]();
  assert.match((await timedOut).error, /Timed out/);
  assert.equal(timers.size, 0);
}
async function checkContextTimeouts() {
  for (const [source, name] of [[content, "enrichHeadlinesWithContext"], [background, "enrichWithContext"]]) {
    let timeout;
    const reading = deferred();
    const context = vm.createContext({
      URL, AbortController, TextDecoder, console,
      window: { location: { hostname: "news.walla.co.il" } },
      _ctxBlockedUntil: 0, ctxHostBlocked: () => false,
      CONFIG: { CONTEXT_CONCURRENCY: 3, CONTEXT_MAX_BYTES: 524288, CONTEXT_TIMEOUT_MS: 6000 },
      setTimeout: fn => { timeout = fn; return 1; },
      clearTimeout: () => { timeout = null; },
      fetch: async (_url, { signal }) => ({
        ok: true, status: 200, headers: { get: () => "text/html" },
        body: { getReader: () => ({ read: () => {
          reading.resolve();
          return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout"))));
        } }) },
      }),
    });
    load(source, name, context);
    const pending = context[name]([{ id: "headline-0", url: "https://news.walla.co.il/item/1" }]);
    await reading.promise;
    assert.equal(typeof timeout, "function", "timeout must cover stalled response bodies, not only headers");
    timeout();
    assert.equal((await pending)[0].id, "headline-0");
    assert.equal(timeout, null);
  }
}
(async () => {
  await checkStream();
  await checkBatches();
  await checkBatches(true);
  await checkCompletion();
  await checkContextTimeouts();
  console.log("PASS: incremental Hebrew streaming, network fragments, small groups, errors, busy state, and timer cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });
