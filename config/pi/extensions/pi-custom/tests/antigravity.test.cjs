const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { execFileSync } = require("node:child_process");
const { realpathSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { dirname, join } = require("node:path");
const { tmpdir } = require("node:os");
const { request: httpRequest } = require("node:http");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const CUSTOM = join(__dirname, "..");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));
const jiti = createJiti(__filename, {
  alias: {
    "@earendil-works/pi-ai/compat": join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-ai": join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-coding-agent": join(PI_PACKAGE, "dist/index.js"),
  },
});
let createAntigravityBridge, registerAntigravity, ai, model, estimateMessageTokens, splitPromptText;
const user = (content) => ({ role: "user", content, timestamp: 0 });
const tool = { name: "echo", description: "Echo input", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  throw new Error("Expected asynchronous state was not reached");
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

before(async () => {
  ({ createAntigravityBridge } = await jiti.import(join(CUSTOM, "antigravity/bridge.ts")));
  ({ registerAntigravity } = await jiti.import(join(CUSTOM, "antigravity.ts")));
  ai = await jiti.import("@earendil-works/pi-ai");
  ({ estimateMessageTokens } = await jiti.import(join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/utils/estimate.js")));
  ({ splitPromptText } = await jiti.import(join(CUSTOM, "antigravity/history.ts")));
  model = { ...ai.getModel("anthropic", "claude-haiku-4-5"), id: "gemini-test", provider: "antigravity", api: "antigravity" };
});

function fitInputBudget(unit, tokens) {
  const count = text => splitPromptText(text).reduce((sum, chunk) => sum + estimateMessageTokens(user(chunk)), 0);
  let low = 0, high = Math.ceil(tokens * 4 / unit.length);
  assert.ok(count(unit.repeat(high)) > tokens);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (count(unit.repeat(middle)) <= tokens) low = middle;
    else high = middle - 1;
  }
  let text = unit.repeat(low);
  while (count(text + "x") <= tokens) text += "x";
  assert.equal(count(text), tokens);
  assert.equal(count(text + "x"), tokens + 1);
  return text;
}

const agentCapabilities = {
  _meta: { antigravity: { systemPrompt: { append: true } } },
  mcpCapabilities: { http: true },
  promptCapabilities: { image: true, embeddedContext: true },
};

function harness(t, initialized = { agentCapabilities }, session = {}, options = {}) {
  const connections = [];
  const usageReader = () => {
    let toolUsage;
    return {
      beginPrompt() { toolUsage = undefined; },
      readTool() {
        toolUsage = options.toolUsage ?? { index: 0, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
        return { ...toolUsage, generationIndex: toolUsage.index, totalTokens: toolUsage.input + toolUsage.cacheRead + toolUsage.output, generations: [toolUsage],
          contextIntegrity: options.toolIntegrity ?? { status: "intact" } };
      },
      readCompletion(used) {
        const row = (typeof options.lastUsage === "function" ? options.lastUsage(used) : options.lastUsage)
          ?? { index: toolUsage ? 1 : 0, input: used, output: 0, cacheRead: 0, cacheWrite: 0 };
        return { ...row, generationIndex: row.index, totalTokens: used, generations: (typeof options.generations === "function" ? options.generations(used) : options.generations) ?? [...(toolUsage ? [toolUsage] : []), row],
          contextIntegrity: options.lastIntegrity ?? { status: "intact" } };
      },
    };
  };
  const bridge = createAntigravityBridge({ usageReader, ...options, cwd: () => CUSTOM, connect: async (cwd, handlers, tools, env, signal, profile) => {
    let used;
    const update = params => {
      if (params.sessionId === connection.sessionId && params.update?.sessionUpdate === "usage_update"
        && Number.isSafeInteger(params.update.used) && params.update.used > 0) used = params.update.used;
      handlers.update(params);
    };
    const connection = {
      cwd, handlers: { ...handlers, update }, tools, profile, initialized: options.initialized?.(profile) ?? initialized, mcpServer: { name: "pi", type: "http", url: `http://fixture.invalid/mcp/${connections.length}` },
      calls: [], prompts: [], watchdogs: [], closed: false,
      close() { this.closed = true; return options.stopped?.(this) ?? Promise.resolve(); },
      setPromptWatchdog(sessionId, settings) { this.watchdogs.push({ sessionId, settings }); },
      request(method, params, settings) {
        this.calls.push({ method, params });
        options.request?.(method, params);
        if (method === "session/new" || method === "session/resume") {
          this.sessionId = params.sessionId ?? (profile?.historyTarget ? randomUUID() : `session-${connections.length}`);
          if (method === "session/new") options.newSession?.(this);
          return Promise.resolve({ sessionId: this.sessionId, ...session });
        }
        if (method === "session/close") return Promise.resolve({});
        if (method === "session/set_config_option" || method === "session/set_model") return Promise.resolve({});
        if (method === "session/prompt") {
          used = undefined;
          const pending = deferred();
          this.prompts.push({ params, settings, ...pending });
          return pending.promise;
        }
        throw new Error(`Unexpected request: ${method}`);
      },
      chunk(text, sessionUpdate = "agent_message_chunk", sessionId = this.sessionId) {
        update({ sessionId, update: { sessionUpdate, content: { type: "text", text } } });
      },
      finish(response = { stopReason: "end_turn" }) {
        const total = response.usage ? (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0) + (response.usage.cachedReadTokens ?? 0) : 1;
        if (!options.omitUsageUpdate) update({ sessionId: this.sessionId, update: { sessionUpdate: "usage_update", used: used ?? total } });
        this.prompts.at(-1).resolve(response);
      },
    };
    connections.push(connection);
    await options.connectionReady?.();
    return connection;
  } });
  t.after(() => bridge.reset());
  const stream = (messages, settings = {}, systemPrompt = "Use Pi tools only.") => bridge.streamSimple(model,
    ai.normalizeContext({ systemPrompt, tools: [tool], messages }), settings);
  return { bridge, connections, stream };
}

async function started(h, messages, index = 0, settings = {}, systemPrompt) {
  const stream = h.stream(messages, settings, systemPrompt);
  await until(() => h.connections[index]?.prompts.length > 0);
  return { stream, connection: h.connections[index] };
}

function importFixture(t, extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-import-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databases = [];
  const h = harness(t, { agentCapabilities, agentInfo: { version: extra.version ?? "1.5.15" } }, extra.session ?? {}, {
    piSessionId: () => "pi-import-owner",
    initialized: profile => profile?.historyTarget ? {
      agentCapabilities: { ...agentCapabilities, mcpCapabilities: { http: false } }, agentInfo: { version: extra.version ?? "1.5.15" },
    } : undefined,
    ...extra,
    newSession(connection) {
      if (!connection.profile?.historyTarget) return;
      const path = join(connection.profile.geminiDir, "antigravity-cli", "conversations", connection.sessionId + ".db");
      mkdirSync(dirname(path), { recursive: true });
      const db = new DatabaseSync(path);
      db.exec(`
        CREATE TABLE steps (idx INTEGER PRIMARY KEY ${extra.failInsert ? 'CHECK (idx < 1)' : ''}, step_type INTEGER NOT NULL DEFAULT 0,
          status INTEGER NOT NULL DEFAULT 0, has_subtrajectory NUMERIC NOT NULL DEFAULT false,
          metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB,
          step_payload BLOB, step_format INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE battle_mode_infos (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY DEFAULT 'main', data BLOB);
      `);
      db.prepare("INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)").run(randomUUID(), connection.sessionId);
      db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(Buffer.from("native-fixture"));
      if (extra.badLayout) db.exec("CREATE TABLE unsupported (id INTEGER)");
      db.close();
      databases.push(path);
    },
  });
  return { ...h, root, databases, settings: { env: { GEMINI_HOME: root } } };
}
const importedHistory = () => [user("prior"), { role: "assistant", content: [{ type: "text", text: "old answer" }], stopReason: "stop", timestamp: 0 }, user("new request")];
function importedRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT * FROM steps").all(); } finally { db.close(); }
}

function nativeField(bytes, ...path) {
  const data = Buffer.from(bytes);
  let offset = 0;
  const integer = () => {
    let value = 0, factor = 1, byte;
    do { byte = data[offset++]; value += (byte & 127) * factor; factor *= 128; } while (byte & 128);
    return value;
  };
  while (offset < data.length) {
    const tag = integer();
    let value;
    if (tag % 8 === 0) value = integer();
    else { assert.equal(tag % 8, 2); const size = integer(); value = data.subarray(offset, offset + size); offset += size; }
    if (tag >> 3 === path[0]) return path.length === 1 ? value : nativeField(value, ...path.slice(1));
  }
}

test("long first prompts preserve ASCII, Chinese, multibyte text and separators in one active request", async (t) => {
  for (const inputs of [
    ["x".repeat(184998) + "FINAL instruction crosses the split"],
    ["中文".repeat(40000)],
    ["😀".repeat(50000)],
    ["a".repeat(180000) + "\r\n\r\n", "中".repeat(4000) + "\n\nEND instruction"],
    [[{ type: "text", text: "x".repeat(100000) }, { type: "text", text: "y".repeat(90000) }]],
  ]) {
    const h = importFixture(t, { independent: true, onImport: () => assert.fail("Splitting is lossless") });
    const messages = inputs.map(user), original = structuredClone(messages);
    const expected = inputs.map(input => typeof input === "string" ? input : input.map(block => block.text).join("")).join("\n\n");
    const { stream, connection } = await started(h, messages, 1, h.settings);
    const rows = importedRows(h.databases[0]);
    assert.ok(rows.every(row => row.step_type === 14));
    const chunks = [...rows.map(row => nativeField(row.step_payload, 19, 2).toString()), connection.prompts[0].params.prompt[0].text];
    assert.ok(chunks.every(chunk => chunk.isWellFormed() && Buffer.byteLength(chunk) <= 185000));
    assert.equal(chunks.join(""), expected);
    assert.equal(connection.prompts[0].params.prompt.length, 1);
    assert.equal(h.connections[0].closed, true);
    assert.equal(h.connections.reduce((sum, item) => sum + item.prompts.length, 0), 1);
    connection.chunk("done"); connection.finish();
    assert.equal((await stream.result()).stopReason, "stop");
    assert.deepEqual(messages, original);
  }
});

test("long current input rebuilds live and resumed sessions without changing old databases or Pi bookkeeping", async (t) => {
  for (const restore of [false, true]) {
    let saved;
    const h = importFixture(t, { save: state => { saved = structuredClone(state); return true; }, claim: () => true });
    const messages = importedHistory();
    const first = await started(h, messages, 1, h.settings);
    first.connection.chunk("first answer"); first.connection.finish();
    messages.push(await first.stream.result());
    h.bridge.settle();
    const oldBytes = readFileSync(h.databases[0]);
    if (restore) { h.bridge.reset(); h.bridge.restore(saved); }
    messages.push(user("z".repeat(184998) + "FINAL instruction crosses boundary"));
    const original = structuredClone(messages);
    const next = await started(h, messages, 3, h.settings);
    assert.equal(first.connection.closed, true);
    assert.equal(h.connections[2].closed, true);
    assert.notEqual(next.connection.sessionId, first.connection.sessionId);
    assert.deepEqual(readFileSync(h.databases[0]), oldBytes);
    const rows = importedRows(h.databases[1]);
    assert.deepEqual(rows.map(row => row.step_type), [14, 15, 14, 15, 14]);
    assert.equal(nativeField(rows[0].step_payload, 19, 2).toString(), "prior");
    assert.equal(nativeField(rows[3].step_payload, 20, 1).toString(), "first answer");
    assert.equal(nativeField(rows[4].step_payload, 19, 2).toString() + next.connection.prompts[0].params.prompt[0].text, messages.at(-1).content);
    next.connection.chunk("second answer"); next.connection.finish();
    const answer = await next.stream.result();
    assert.equal(answer.stopReason, "stop");
    assert.deepEqual(messages, original);
    h.bridge.settle();
    const ledger = [...messages, answer];
    assert.equal(saved.historyLength, ledger.length);
    assert.equal(saved.historyKey, createHash("sha256").update(JSON.stringify(ledger.map(({ role, content, toolCallId, toolName, isError }) => ({ role, content, toolCallId, toolName, isError })))).digest("hex"));
    h.bridge.reset(); h.bridge.restore(saved);
    const resumed = await started(h, [...ledger, user("follow up")], 4, h.settings);
    assert.equal(resumed.connection.sessionId, next.connection.sessionId);
    assert.equal(h.databases.length, 2);
    assert.deepEqual(resumed.connection.prompts[0].params.prompt, [{ type: "text", text: "follow up" }]);
    resumed.connection.chunk("done"); resumed.connection.finish();
    assert.equal((await resumed.stream.result()).stopReason, "stop");
  }
});

test("independent imports preserve history beyond the removed byte cap", async (t) => {
  const h = importFixture(t, { independent: true });
  const messages = [user("old"), { role: "assistant", content: [{ type: "text", text: "a".repeat(400000) }], stopReason: "stop" },
    user("recent"), { role: "assistant", content: [{ type: "text", text: "b".repeat(100000) }], stopReason: "stop" }, user("summarize")];
  const original = structuredClone(messages);
  const { stream, connection } = await started(h, messages, 1, h.settings);
  const rows = importedRows(h.databases[0]);
  assert.deepEqual(rows.map(row => nativeField(row.step_payload, row.step_type === 14 ? 19 : 20, row.step_type === 14 ? 2 : 1).toString()),
    ["old", "a".repeat(400000), "recent", "b".repeat(100000)]);
  connection.chunk("Summary"); connection.finish();
  assert.equal((await stream.result()).stopReason, "stop");
  assert.deepEqual(messages, original);
});

test("imports the whole prefix once after writer stop and sends only the new user suffix", async (t) => {
  const stopped = deferred(), notices = [];
  let saved;
  const h = importFixture(t, { stopped: c => c.calls.some(x => x.method === "session/close") ? stopped.promise : undefined,
    save: state => { saved = state; return true; }, claim: () => true,
    onImport(losses) {
      assert.equal(h.connections[1].calls[0].method, "session/resume");
      assert.ok(h.connections[1].calls.some(call => call.method === "session/set_model"));
      assert.equal(h.connections[1].prompts.length, 0);
      notices.push(losses);
    },
  });
  const messages = importedHistory();
  messages[0].content = "中文".repeat(40000);
  messages.splice(2, 0,
    { role: "assistant", content: [{ type: "toolCall", id: "completed-call", name: "echo", arguments: { value: "old input" } }], stopReason: "toolUse", timestamp: 0 },
    { role: "toolResult", toolCallId: "completed-call", toolName: "echo", content: [{ type: "text", text: "old receipt".repeat(5_000) }, { type: "image", mimeType: "image/png", data: "AA==" }], isError: false, timestamp: 0 });
  const stream = h.stream(messages, { ...h.settings, sessionId: "pi-import-owner" });
  await until(() => h.connections[0]?.closed);
  assert.equal(importedRows(h.databases[0]).length, 0);
  assert.equal(h.connections.length, 1);
  assert.equal(saved, undefined);
  assert.deepEqual(notices, []);
  stopped.resolve();
  await until(() => h.connections[1]?.prompts.length);
  const initial = h.connections[0], resumed = h.connections[1];
  assert.deepEqual(notices, [{ toolResultsTruncated: 1, toolImagesOmitted: 1 }]);
  assert.deepEqual(initial.calls.map(x => x.method), ["session/new", "session/close"]);
  assert.deepEqual(initial.tools, []);
  assert.deepEqual(initial.calls[0].params.mcpServers, []);
  assert.deepEqual(initial.calls[0].params._meta.antigravity.eagerMcpServers, []);
  await assert.rejects(initial.handlers.tool("echo", { value: "must not execute" }), /history setup cannot execute tools/);
  assert.deepEqual(resumed.tools, [tool]);
  assert.equal(initial.prompts.length, 0);
  assert.deepEqual(importedRows(h.databases[0]).map(row => row.step_type), [14, 14, 15, 15, 132]);
  assert.equal(resumed.calls[0].method, "session/resume");
  assert.equal(resumed.sessionId, initial.sessionId);
  assert.deepEqual(initial.profile, { ...resumed.profile, historyTarget: true });
  assert.notEqual(resumed.mcpServer.url, initial.mcpServer.url);
  assert.deepEqual(resumed.prompts[0].params.prompt, [{ type: "text", text: "new request" }]);
  assert.deepEqual(resumed.profile, { geminiDir: h.root });
  assert.equal(dirname(dirname(h.databases[0])), join(h.root, "antigravity-cli"));
  resumed.chunk("completed"); resumed.finish();
  const answer = await stream.result();
  assert.equal(answer.stopReason, "stop");
  assert.equal(saved, undefined);
  h.bridge.settle();
  assert.equal(saved.appDataDir, undefined);
  assert.equal(saved.imported, true);
  h.bridge.reset(); h.bridge.restore(saved);
  const next = await started(h, [...messages, answer, user("follow up")], 2, h.settings);
  assert.equal(next.connection.calls[0].method, "session/resume");
  assert.deepEqual(next.connection.profile, resumed.profile);
  assert.equal(h.databases.length, 1);
  assert.equal(notices.length, 1);
  next.connection.chunk("done"); next.connection.finish();
  await next.stream.result();
});

test("shared-profile imports leave neighboring databases and the shared index untouched", async (t) => {
  for (const failInsert of [false, true]) {
    const h = importFixture(t, { failInsert });
    const profile = join(h.root, "antigravity-cli");
    mkdirSync(join(profile, "conversations"), { recursive: true });
    const neighbor = join(profile, "conversations", randomUUID() + ".db");
    const index = join(profile, "conversation_summaries.db");
    writeFileSync(neighbor, "existing-session");
    writeFileSync(index, "native-owned-index");
    if (failInsert) {
      assert.match((await h.stream(importedHistory(), h.settings).result()).errorMessage, /CHECK constraint/);
      assert.equal(importedRows(h.databases[0]).length, 0);
    } else {
      const next = await started(h, importedHistory(), 1, h.settings);
      next.connection.chunk("done"); next.connection.finish();
      await next.stream.result();
    }
    assert.equal(readFileSync(neighbor, "utf8"), "existing-session");
    assert.equal(readFileSync(index, "utf8"), "native-owned-index");
    assert.equal(readdirSync(join(profile, "conversations")).length, 2);
  }
});

test("a native new response cannot authorize an already existing session database", async (t) => {
  const existingId = randomUUID();
  const h = importFixture(t, { session: { sessionId: existingId } });
  const directory = join(h.root, "antigravity-cli", "conversations");
  mkdirSync(directory, { recursive: true });
  const existing = join(directory, existingId + ".db");
  writeFileSync(existing, "existing-session");
  const result = await h.stream(importedHistory(), h.settings).result();
  assert.match(result.errorMessage, /history storage layout is unsupported/);
  assert.equal(readFileSync(existing, "utf8"), "existing-session");
  assert.deepEqual(h.connections[0].calls.map(call => call.method), ["session/new"]);
  assert.equal(h.connections[0].closed, true);
  assert.equal(importedRows(h.databases[0]).length, 0);
});

test("legacy owned-profile checkpoints are invalidated without removing their directories", async (t) => {
  let saved;
  const h = importFixture(t, { save: state => { saved = state; return true; }, claim: () => true });
  const messages = importedHistory();
  const first = await started(h, messages, 1, h.settings);
  first.connection.chunk("done"); first.connection.finish();
  messages.push(await first.stream.result(), user("next"));
  h.bridge.settle();
  const oldName = "pi-history-" + randomUUID();
  mkdirSync(join(h.root, oldName));
  writeFileSync(join(h.root, oldName, "keep"), "old-owned-session");
  h.bridge.reset(); h.bridge.restore({ ...saved, appDataDir: oldName });
  const next = await started(h, messages, 3, h.settings);
  assert.equal(h.connections[2].calls[0].method, "session/new");
  assert.notEqual(next.connection.sessionId, saved.sessionId);
  assert.equal(readFileSync(join(h.root, oldName, "keep"), "utf8"), "old-owned-session");
  next.connection.chunk("done"); next.connection.finish();
  await next.stream.result();
});

test("inherited Gemini root changes invalidate checkpoints without touching the prior root", async (t) => {
  let saved;
  const previous = process.env.GEMINI_HOME;
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = previous; });
  const h = importFixture(t, { save: state => { saved = state; return true; }, claim: () => true });
  process.env.GEMINI_HOME = h.root;
  const messages = importedHistory();
  const first = await started(h, messages, 1);
  first.connection.chunk("done"); first.connection.finish();
  messages.push(await first.stream.result(), user("next"));
  h.bridge.settle();
  const original = readFileSync(h.databases[0]);
  const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-import-other-root-")));
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }));
  process.env.GEMINI_HOME = otherRoot;
  h.bridge.reset(); h.bridge.restore(saved);
  const next = await started(h, messages, 3);
  assert.equal(h.connections[2].profile.geminiDir, otherRoot);
  assert.equal(h.connections[2].calls[0].method, "session/new");
  assert.deepEqual(readFileSync(h.databases[0]), original);
  next.connection.chunk("done"); next.connection.finish();
  await next.stream.result();
});

test("a newly created Gemini root keeps the first ordinary checkpoint valid", { timeout: 3000 }, async (t) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "pi-new-gemini-root-")));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "new-root"), settings = { env: { GEMINI_HOME: root } };
  let saved;
  const h = harness(t, { agentCapabilities }, {}, {
    initialized(profile) {
      assert.deepEqual(profile, { geminiDir: root });
      mkdirSync(root, { recursive: true });
      return { agentCapabilities };
    },
    save: state => { saved = state; return true; }, claim: () => true,
  });
  const first = await started(h, [user("first")], 0, settings);
  first.connection.chunk("done"); first.connection.finish();
  const answer = await first.stream.result();
  h.bridge.settle(); h.bridge.reset(); h.bridge.restore(saved);
  const next = await started(h, [user("first"), answer, user("next")], 1, settings);
  assert.equal(next.connection.calls[0].method, "session/resume");
  assert.equal(next.connection.sessionId, saved.sessionId);
  next.connection.chunk("done"); next.connection.finish();
  assert.equal((await next.stream.result()).stopReason, "stop");
});

test("ordinary checkpoint resume also rejects a mismatched returned session ID", async (t) => {
  let saved;
  const session = {};
  const h = harness(t, { agentCapabilities }, session, { save: state => { saved = state; return true; }, claim: () => true });
  const first = await started(h, [user("hello")]);
  first.connection.chunk("done"); first.connection.finish();
  const answer = await first.stream.result();
  h.bridge.settle(); h.bridge.reset(); h.bridge.restore(saved);
  session.sessionId = "wrong-session";
  const result = await h.stream([user("hello"), answer, user("next")]).result();
  assert.match(result.errorMessage, /invalid session ID/);
  assert.equal(h.connections[1].calls[0].method, "session/resume");
  assert.equal(h.connections[1].prompts.length, 0);
});

test("history retains every turn and intermediate group with the full filtered checkpoint ledger", async (t) => {
  for (const middleGap of [false, true]) {
    let saved;
    const notices = [];
    const h = importFixture(t, { save: state => { saved = state; return true; }, claim: () => true, onImport: losses => notices.push(losses) });
    const messages = [
      user("old-user".repeat(12_500)),
      { role: "assistant", content: [{ type: "text", text: "old-reply".repeat(12_500) }], stopReason: "stop" },
      { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" },
      user("a".repeat(100_000)),
      { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" },
      { role: "assistant", content: [{ type: "text", text: "b".repeat(170_000) }], stopReason: "stop" },
      user("c".repeat(75_000)), user("d".repeat(75_000)),
    ];
    if (middleGap) messages.splice(5, 0, { role: "assistant", content: [{ type: "text", text: "intermediate".repeat(5_000) }], stopReason: "stop" });
    const original = structuredClone(messages);
    const next = await started(h, messages, 1, h.settings);
    const rows = importedRows(h.databases[0]);
    assert.deepEqual(rows.map(row => nativeField(row.step_payload, row.step_type === 14 ? 19 : 20, row.step_type === 14 ? 2 : 1).toString()),
      messages.slice(0, -2).map(message => typeof message.content === "string" ? message.content : message.content[0].text).filter(Boolean));
    assert.deepEqual(notices, []);
    assert.deepEqual(next.connection.prompts[0].params.prompt, [
      { type: "text", text: messages.at(-2).content }, { type: "text", text: "\n\n" }, { type: "text", text: messages.at(-1).content },
    ]);
    next.connection.chunk("done"); next.connection.finish();
    const answer = await next.stream.result();
    h.bridge.settle();
    assert.equal(saved.historyLength, messages.length + 1);
    const { HISTORY_IMPORT_POLICY } = await jiti.import(join(CUSTOM, "antigravity/history.ts"));
    const { AGENT_DEFINITION } = await jiti.import(join(CUSTOM, "antigravity/transport.ts"));
    const configParts = [AGENT_DEFINITION, HISTORY_IMPORT_POLICY,
      "Use only the Pi tools exposed through MCP. Short tool names in the following instructions refer to their mcp_pi_<name> counterparts.",
      CUSTOM, "Use Pi tools only.", [tool], h.settings.env, h.root];
    assert.equal(saved.configuration, createHash("sha256").update(JSON.stringify(configParts)).digest("hex"));
    h.bridge.reset(); h.bridge.restore(saved);
    const resumed = await started(h, [...messages, answer, user("follow up")], 2, h.settings);
    assert.equal(resumed.connection.calls[0].method, "session/resume");
    assert.deepEqual(resumed.connection.prompts[0].params.prompt, [{ type: "text", text: "follow up" }]);
    assert.equal(h.databases.length, 1);
    assert.equal(notices.length, 0);
    resumed.connection.chunk("finished"); resumed.connection.finish();
    assert.equal((await resumed.stream.result()).stopReason, "stop");
    assert.deepEqual(messages, original);
  }
});

test("history import and owned resume accept versions at or above stable 1.5.15", async (t) => {
  for (const version of ["1.5.15", "1.5.15+build.1", "1.5.16-rc.1", "1.6.0-rc.1", "1.10.0", "2.0.0"]) {
    const h = importFixture(t, { version });
    const next = await started(h, importedHistory(), 1, h.settings);
    assert.equal(h.databases.length, 1, version);
    assert.equal(next.connection.calls[0].method, "session/resume", version);
    assert.deepEqual(next.connection.prompts[0].params.prompt, [{ type: "text", text: "new request" }]);
    next.connection.chunk("done"); next.connection.finish();
    assert.equal((await next.stream.result()).stopReason, "stop", version);
  }
});

test("old or unparseable import versions fail without a fallback prompt", async (t) => {
  for (const version of ["1.5.14", "1.5.15-rc.1", "1.5.15-rc.1+build.1", "1.4.99", "0.99.99", "unknown", "", "1.5", "9007199254740992.0.0"]) {
    const h = importFixture(t, { version });
    const messages = importedHistory();
    messages[0].content = "x".repeat(185001);
    const result = await h.stream(messages, h.settings).result();
    assert.equal(result.errorMessage, "Antigravity history import requires CLI 1.5.15 or later.", version);
    assert.equal(h.databases.length, 0);
    assert.equal(h.connections.length, 1);
    assert.equal(h.connections.reduce((n, c) => n + c.prompts.length, 0), 0);
    assert.deepEqual(readdirSync(h.root), []);
  }
});

test("missing import versions and downgraded owned checkpoints fail without fallback", async (t) => {
  const missing = importFixture(t, { initialized: () => ({ agentCapabilities }) });
  const refused = await missing.stream(importedHistory(), missing.settings).result();
  assert.equal(refused.errorMessage, "Antigravity history import requires CLI 1.5.15 or later.");
  assert.equal(missing.connections.length, 1);
  assert.equal(missing.connections[0].prompts.length, 0);
  assert.deepEqual(readdirSync(missing.root), []);

  let saved, version = "1.5.16";
  const h = importFixture(t, { initialized: () => ({ agentCapabilities, agentInfo: { version } }), save(state) { saved = state; } });
  const messages = importedHistory();
  const first = await started(h, messages, 1, h.settings);
  first.connection.chunk("done"); first.connection.finish();
  messages.push(await first.stream.result(), user("follow up"));
  h.bridge.settle();
  h.bridge.reset(); h.bridge.restore(saved);
  version = "1.5.14";
  const answer = await h.stream(messages, h.settings).result();
  assert.equal(answer.errorMessage, "Antigravity history import requires CLI 1.5.15 or later.");
  assert.equal(h.connections.length, 3);
  assert.equal(h.connections[2].prompts.length, 0);
  assert.equal(h.connections[2].closed, true);
  assert.deepEqual(readdirSync(h.root), ["antigravity-cli"]);
});

test("model changes retain the imported checkpoint version gate", async (t) => {
  let saved, version = "1.5.17";
  const h = importFixture(t, { initialized: () => ({ agentCapabilities, agentInfo: { version } }),
    save: state => { saved = state; return true; }, claim: () => true });
  const messages = importedHistory();
  const first = await started(h, messages, 1, h.settings);
  first.connection.chunk("done"); first.connection.finish();
  messages.push(await first.stream.result(), user("next"));
  h.bridge.settle();
  assert.equal(saved.imported, true);
  version = "1.5.14";
  const result = await h.bridge.streamSimple({ ...model, id: "another-model" },
    ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools: [tool], messages }), h.settings).result();
  assert.match(result.errorMessage, /requires CLI 1.5.15 or later/);
  assert.equal(h.connections.length, 3);
  assert.equal(h.connections[2].prompts.length, 0);
  assert.equal(h.databases.length, 1);
});

test("unknown import layout retains the new native session and fails without fallback", async (t) => {
  const h = importFixture(t, { badLayout: true });
  writeFileSync(join(h.root, "unrelated"), "keep");
  const answer = await h.stream(importedHistory(), h.settings).result();
  assert.equal(answer.errorMessage, "Antigravity history storage layout is unsupported.");
  assert.equal(h.connections.length, 1);
  assert.equal(h.connections[0].prompts.length, 0);
  assert.deepEqual(readdirSync(h.root), ["antigravity-cli", "unrelated"]);
  assert.equal(importedRows(h.databases[0]).length, 0);
});

test("error and aborted assistants are omitted consistently from imports and checkpoint accounting", async (t) => {
  let saved;
  const h = importFixture(t, { save: state => { saved = state; return true; }, claim: () => true });
  const omitted = [
    { role: "assistant", content: [], stopReason: "error", timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "aborted partial" }], stopReason: "aborted", timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id: "unexecuted", name: "echo", arguments: { value: "never run" } }], stopReason: "error", timestamp: 0 },
  ];
  const messages = importedHistory();
  messages.splice(2, 0, ...omitted);
  const original = structuredClone(messages);
  const next = await started(h, messages, 1, h.settings);
  assert.deepEqual(importedRows(h.databases[0]).map(row => row.step_type), [14, 15]);
  assert.deepEqual(next.connection.prompts[0].params.prompt, [{ type: "text", text: "new request" }]);
  next.connection.chunk("done"); next.connection.finish();
  const answer = await next.stream.result();
  h.bridge.settle();
  assert.equal(saved.historyLength, 4);
  h.bridge.reset(); h.bridge.restore(saved);
  const resumed = await started(h, [...messages, answer, user("follow up")], 2, h.settings);
  assert.equal(resumed.connection.calls[0].method, "session/resume");
  assert.deepEqual(resumed.connection.prompts[0].params.prompt, [{ type: "text", text: "follow up" }]);
  resumed.connection.chunk("finished"); resumed.connection.finish();
  assert.equal((await resumed.stream.result()).stopReason, "stop");
  assert.deepEqual(messages, original);

  const empty = importFixture(t);
  const direct = await started(empty, [...omitted, user("fresh request")], 0, empty.settings);
  assert.equal(empty.databases.length, 0);
  assert.deepEqual(direct.connection.prompts[0].params.prompt, [{ type: "text", text: "fresh request" }]);
  direct.connection.chunk("done"); direct.connection.finish();
  assert.equal((await direct.stream.result()).stopReason, "stop");
});

test("session-close failure propagates without fallback after confirmed writer stop", async (t) => {
  const h = importFixture(t, { request(method) { if (method === "session/close") throw new Error("native close failed"); } });
  const result = await h.stream(importedHistory(), h.settings).result();
  assert.equal(result.errorMessage, "native close failed");
  assert.equal(h.connections.length, 1);
  assert.equal(h.connections[0].prompts.length, 0);
  assert.deepEqual(readdirSync(h.root), ["antigravity-cli"]);
  assert.equal(importedRows(h.databases[0]).length, 0);
});

test("native-root filesystem failures propagate before any connection or profile creation", { timeout: 3000 }, async (t) => {
  const h = importFixture(t);
  const file = join(h.root, "not-a-directory");
  writeFileSync(file, "keep");
  const result = await h.stream(importedHistory(), { env: { GEMINI_HOME: join(file, "child") } }).result();
  assert.match(result.errorMessage, /ENOTDIR/);
  assert.equal(h.connections.length, 0);
  assert.deepEqual(readdirSync(h.root), ["not-a-directory"]);
});

test("unreadable shared conversations stop import before creating a native session", { timeout: 3000, skip: process.getuid?.() === 0 }, async (t) => {
  const h = importFixture(t);
  const directory = join(h.root, "antigravity-cli", "conversations");
  mkdirSync(directory, { recursive: true });
  const sentinel = join(directory, "existing.db");
  writeFileSync(sentinel, "keep");
  const { chmodSync } = require("node:fs");
  chmodSync(directory, 0o000);
  try {
    const result = await h.stream(importedHistory(), h.settings).result();
    assert.match(result.errorMessage, /EACCES/);
    assert.equal(h.connections.length, 0);
  } finally { chmodSync(directory, 0o700); }
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
});

test("history write failures roll back and retain the new native session without fallback", async (t) => {
  const h = importFixture(t, { failInsert: true, onImport: () => assert.fail("Failed writes must not notify") });
  const messages = importedHistory();
  messages[0].content = "x".repeat(185001);
  const result = await h.stream(messages, h.settings).result();
  assert.match(result.errorMessage, /CHECK constraint failed/);
  assert.equal(h.connections.length, 1);
  assert.equal(h.connections[0].prompts.length, 0);
  assert.deepEqual(readdirSync(h.root), ["antigravity-cli"]);
  assert.equal(importedRows(h.databases[0]).length, 0);
});

test("failed worker resume retains imported resources without fallback or a parent-stop deletion", async (t) => {
  const h = importFixture(t, { request(method) { if (method === "session/resume") throw new Error("worker resume failed"); },
    onImport: () => assert.fail("Failed resumes must not notify") });
  const messages = importedHistory();
  messages[0].content = "x".repeat(185001);
  const result = await h.stream(messages, h.settings).result();
  assert.equal(result.errorMessage, "worker resume failed");
  assert.equal(h.connections.length, 2);
  assert.equal(h.connections[1].profile.historyTarget, undefined);
  assert.equal(h.connections[1].prompts.length, 0);
  assert.equal(importedRows(h.databases[0]).length, 3);
  assert.equal(readdirSync(h.root).length, 1);
});

test("unconfirmed writer stop neither writes nor deletes native resources nor falls back", async (t) => {
  const h = importFixture(t, { stopped: () => Promise.reject(new Error("writer stop unconfirmed")) });
  const result = await h.stream(importedHistory(), h.settings).result();
  assert.equal(result.errorMessage, "writer stop unconfirmed");
  assert.equal(h.connections.length, 1);
  assert.equal(h.connections[0].prompts.length, 0);
  assert.equal(importedRows(h.databases[0]).length, 0);
  assert.equal(readdirSync(h.root).length, 1);
});

test("branch reset during native writer stop aborts import without writing or fallback", async (t) => {
  const stopped = deferred();
  const h = importFixture(t, { stopped: () => stopped.promise });
  const stream = h.stream(importedHistory(), h.settings);
  await until(() => h.connections[0]?.closed);
  h.bridge.reset();
  assert.equal(importedRows(h.databases[0]).length, 0);
  stopped.resolve();
  assert.equal((await stream.result()).stopReason, "error");
  await tick();
  assert.deepEqual(readdirSync(h.root), ["antigravity-cli"]);
  assert.equal(importedRows(h.databases[0]).length, 0);
  assert.equal(h.connections.length, 1);
  assert.equal(h.connections[0].prompts.length, 0);
});

test("native final usage separates current occupancy from raw cumulative input and output", async (t) => {
  const h = harness(t, undefined, {}, { lastUsage: { index: 1, input: 2214, output: 10, cacheRead: 935, cacheWrite: 0 },
    generations: [{ index: 0, input: 2984, output: 71, cacheRead: 0, cacheWrite: 0 }, { index: 1, input: 2214, output: 10, cacheRead: 935, cacheWrite: 0 }] });
  const { stream, connection } = await started(h, [user("usage")]);
  connection.handlers.update({ sessionId: connection.sessionId, update: { sessionUpdate: "usage_update", used: 3159 } });
  connection.chunk("done");
  connection.finish({ stopReason: "end_turn", usage: {
    inputTokens: 5198, cachedReadTokens: 935, outputTokens: 81, thoughtTokens: 42, totalTokens: 6214,
  }, _meta: { quota: { token_count: { input_tokens: null, output_tokens: null } } } });
  const answer = await stream.result();
  assert.deepEqual([answer.usage.input, answer.usage.cacheRead, answer.usage.output, answer.usage.totalTokens], [2224, 935, 10, 3159]);
  assert.deepEqual(answer.usage.antigravity.raw, { input: 5198, output: 81, cacheRead: 935, cacheWrite: 0 });
  assert.equal(answer.usage.input + answer.usage.cacheRead, answer.usage.totalTokens);
  assert.deepEqual(answer.usage.antigravity.acp, { inputTokens: 5198, outputTokens: 81, cachedReadTokens: 935, cachedWriteTokens: null, thoughtTokens: 42, totalTokens: 6214 });
});

test("Pi compacts successful over-window occupancy without replaying the completed turn", async () => {
  const { AgentSession } = await jiti.import(join(PI_PACKAGE, "dist/core/agent-session.js"));
  for (const used of [256000, 256001]) {
    const selected = { ...model, contextWindow: 256000 }, calls = [];
    const session = {
      model: selected,
      settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 0 }) },
      _modelForMessage: () => selected,
      _findPersistedMessageEntryId: () => undefined,
      sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ entries: [] }) },
      _runAutoCompaction: async (reason, willRetry) => { calls.push({ reason, willRetry }); return false; },
    };
    const answer = { role: "assistant", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 1,
      usage: { input: used - 935, cacheRead: 935, output: 10, cacheWrite: 0, totalTokens: used } };
    assert.equal(await AgentSession.prototype._checkCompaction.call(session, answer), false);
    assert.deepEqual(calls, used === 256000 ? [] : [{ reason: "overflow", willRetry: false }]);
  }
});

test("independent usage remains raw when Pi combines split-summary results", async (t) => {
  const h = harness(t, undefined, {}, { independent: true,
    lastUsage: { index: 0, input: 2214, output: 10, cacheRead: 935, cacheWrite: 0 } });
  const { stream, connection } = await started(h, [user("summary")]);
  connection.handlers.update({ sessionId: connection.sessionId, update: { sessionUpdate: "usage_update", used: 3159 } });
  connection.chunk("summary"); connection.finish();
  const answer = await stream.result();
  assert.deepEqual([answer.usage.input, answer.usage.output, answer.usage.cacheRead, answer.usage.totalTokens], [2214, 10, 935, 3159]);
  const { combineUsage } = await jiti.import(join(PI_PACKAGE, "dist/core/usage-totals.js"));
  const combined = combineUsage(answer.usage, answer.usage);
  assert.deepEqual([combined.input, combined.output, combined.cacheRead, combined.totalTokens], [4428, 20, 1870, 6318]);
  assert.equal(combined.antigravity, undefined);
});

test("multiple tools in one native generation share occupancy without duplicating raw accounting", async (t) => {
  const firstRow = { index: 0, input: 2984, output: 71, cacheRead: 0, cacheWrite: 0 };
  const lastRow = { index: 2, input: 2214, output: 10, cacheRead: 935, cacheWrite: 0 };
  const h = harness(t, undefined, {}, { toolUsage: firstRow, lastUsage: lastRow,
    generations: [firstRow, { index: 1, input: 100, output: 2, cacheRead: 50, cacheWrite: 0 }, lastRow] });
  const messages = [user("two tools")], { stream, connection } = await started(h, messages);
  const replies = [connection.handlers.tool("echo", { value: "first" }), connection.handlers.tool("echo", { value: "second" })];
  let current = stream;
  const raw = [];
  for (let index = 0; index < 2; index++) {
    const answer = await current.result();
    raw.push(answer.usage.antigravity.raw);
    assert.equal(answer.stopReason, "toolUse");
    assert.equal(answer.usage.totalTokens, 3055);
    assert.equal(answer.usage.input + answer.usage.cacheRead, 3055);
    messages.push(answer, { role: "toolResult", toolCallId: answer.content[0].id, toolName: "echo", content: [{ type: "text", text: "done" }] });
    current = h.stream(messages);
    await replies[index];
  }
  connection.handlers.update({ sessionId: connection.sessionId, update: { sessionUpdate: "usage_update", used: 3159 } });
  connection.chunk("done");
  connection.finish({ stopReason: "end_turn", usage: { inputTokens: 5298, outputTokens: 83, cachedReadTokens: 935, cachedWriteTokens: 0 } });
  const final = await current.result();
  assert.equal(final.stopReason, "stop");
  raw.push(final.usage.antigravity.raw);
  assert.deepEqual(raw, [
    { input: 2984, output: 71, cacheRead: 0, cacheWrite: 0 },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    { input: 2314, output: 12, cacheRead: 985, cacheWrite: 0 },
  ]);
  assert.equal(final.usage.input + final.usage.cacheRead, 3159);
  assert.equal(final.usage.output, 10);
  assert.equal(final.usage.antigravity.acp.cachedReadTokens, 935, "ambiguous ACP cache scope does not replace per-generation accounting");
  assert.equal(connection.prompts.length, 1);
});

test("missing or stale used observations cannot publish an occupancy pair or retry", async (t) => {
  for (const phase of ["missing", "stale", "same-generation", "same-generation-new-update"]) {
    const h = harness(t, undefined, {}, { omitUsageUpdate: true,
      ...(phase.startsWith("same-generation") ? { lastUsage: { index: 0, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}),
    });
    const messages = [user("usage")], first = await started(h, messages);
    let stream = first.stream;
    if (phase !== "missing") {
      first.connection.handlers.update({ sessionId: first.connection.sessionId, update: { sessionUpdate: "usage_update", used: 1 } });
      const reply = first.connection.handlers.tool("echo", { value: "done" });
      const answer = await stream.result();
      stream = h.stream([...messages, answer, { role: "toolResult", toolCallId: answer.content[0].id, toolName: "echo", content: [{ type: "text", text: "done" }] }]);
      await reply;
    }
    if (phase === "same-generation-new-update") first.connection.handlers.update({ sessionId: first.connection.sessionId, update: { sessionUpdate: "usage_update", used: 1 } });
    first.connection.chunk("done"); first.connection.finish();
    const answer = await stream.result();
    assert.equal(answer.stopReason, "aborted", phase);
    assert.equal(answer.usage.antigravity, undefined);
    assert.equal(ai.isRetryableAssistantError(answer), false);
    assert.equal(ai.isContextOverflow(answer, model.contextWindow), false);
    assert.equal(first.connection.prompts.length, 1);
  }
});

test("unavailable native tool usage stops before delivering a Pi tool", async (t) => {
  const h = harness(t, undefined, {}, { usageReader: () => ({ beginPrompt() {}, readTool() { throw new Error("Antigravity native usage unavailable"); } }) });
  const { stream, connection } = await started(h, [user("tool")]);
  await assert.rejects(connection.handlers.tool("echo", { value: "side effect" }), /native usage unavailable/);
  const answer = await stream.result();
  assert.equal(answer.stopReason, "aborted");
  assert.equal(answer.content.some(block => block.type === "toolCall"), false);
  assert.equal(connection.closed, true);
});

test("unknown or truncated native context stops before a Pi tool can execute", async (t) => {
  for (const status of ["unknown", "truncated"]) {
    const h = harness(t, undefined, {}, { toolIntegrity: { status } });
    const { stream, connection } = await started(h, [user("tool")]);
    await assert.rejects(connection.handlers.tool("echo", { value: "side effect" }), status === "truncated" ? /prompt is too long/ : /native context unavailable/);
    const answer = await stream.result();
    assert.equal(answer.stopReason, "aborted");
    assert.equal(answer.content.some(block => block.type === "toolCall"), false);
    assert.equal(answer.usage.totalTokens, 1, "retain measured usage despite integrity failure");
    assert.equal(ai.isRetryableAssistantError(answer), false);
    assert.equal(ai.isContextOverflow(answer, model.contextWindow), false);
    assert.equal(connection.closed, true);
    assert.equal(connection.prompts.length, 1);
  }
});

test("late integrity failure cannot return a summary or replay a completed native attempt", async (t) => {
  for (const status of ["unknown", "truncated"]) for (const mode of ["ordinary", "independent", "after-tool"]) {
    const h = harness(t, undefined, {}, { independent: mode === "independent", lastIntegrity: { status } });
    const messages = [user("summary")], first = await started(h, messages);
    let stream = first.stream;
    if (mode === "after-tool") {
      const reply = first.connection.handlers.tool("echo", { value: "done" });
      const answer = await stream.result();
      stream = h.stream([...messages, answer, { role: "toolResult", toolCallId: answer.content[0].id, toolName: "echo", content: [{ type: "text", text: "done" }] }]);
      await reply;
    }
    first.connection.chunk("Visible answer"); first.connection.finish();
    const answer = await stream.result();
    assert.equal(answer.stopReason, "aborted", `${status}/${mode}`);
    assert.equal(answer.content[0].text, "Visible answer");
    assert.ok(answer.usage.antigravity);
    assert.equal(ai.isRetryableAssistantError(answer), false);
    assert.equal(ai.isContextOverflow(answer, model.contextWindow), false);
    assert.equal(first.connection.prompts.length, 1);
    assert.equal(h.connections.length, 1);
  }
});

test("text and thinking chunks have balanced events and native usage is independent of quota", { timeout: 3000 }, async (t) => {
  const h = harness(t, { agentCapabilities: { ...agentCapabilities, promptCapabilities: undefined } }, {}, {
    lastUsage: { index: 0, input: 16, output: 10, cacheRead: 4, cacheWrite: 0 },
  });
  const { stream, connection } = await started(h, [user("hello")]);
  assert.deepEqual(connection.tools, [tool]);
  const session = connection.calls[0];
  assert.equal(session.method, "session/new");
  assert.equal(session.params.cwd, CUSTOM);
  assert.deepEqual(session.params.mcpServers, [connection.mcpServer]);
  assert.deepEqual(session.params._meta.antigravity.enabledTools, []);
  assert.deepEqual(session.params._meta.antigravity.eagerMcpServers, ["pi"]);
  assert.match(session.params._meta.antigravity.systemPrompt.append, /Use Pi tools only\./);
  connection.chunk("ignored", "agent_message_chunk", "unrelated-session");
  connection.chunk("pl", "agent_thought_chunk"); connection.chunk("an", "agent_thought_chunk");
  connection.chunk("hello"); connection.chunk(" back");
  connection.finish({ stopReason: "end_turn", usage: { inputTokens: 16, outputTokens: 10, cachedReadTokens: 4, cachedWriteTokens: 0, thoughtTokens: 3 }, _meta: { quota: { token_count: { input_tokens: 20, output_tokens: 7 } } } });
  const answer = await stream.result();
  assert.equal(answer.stopReason, "stop");
  assert.deepEqual(answer.content, [{ type: "thinking", thinking: "plan" }, { type: "text", text: "hello back" }]);
  assert.deepEqual([answer.usage.input, answer.usage.output, answer.usage.cacheRead, answer.usage.cacheWrite, answer.usage.totalTokens], [26, 10, 4, 0, 30]);
  const events = []; for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ["start", "thinking_start", "thinking_delta", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end", "done"]);
});

test("last valid prompt usage update sets occupancy without changing cumulative usage or leaking across prompts", async (t) => {
  const h = harness(t, undefined, {}, {
    lastUsage: used => ({ index: used === 17341 ? 1 : 0, input: used - (used === 17341 ? 120 : 5), output: used === 17341 ? 120 : 5, cacheRead: 0, cacheWrite: 0 }),
    generations: used => used === 17341 ? [
      { index: 0, input: 496586, output: 0, cacheRead: 0, cacheWrite: 0 },
      { index: 1, input: 17221, output: 120, cacheRead: 0, cacheWrite: 0 },
    ] : [{ index: 0, input: 20, output: 5, cacheRead: 0, cacheWrite: 0 }],
  }), history = [user("compact")];
  const { stream, connection } = await started(h, history);
  const update = (used, sessionId = connection.sessionId) => connection.handlers.update({ sessionId, update: { sessionUpdate: "usage_update", used, size: 1048576 } });
  update(496586); update(17341); update(999, "unrelated-session");
  for (const invalid of [0, -1, NaN, Infinity, "100", 1.5]) update(invalid);
  connection.chunk("compacted");
  connection.finish({ stopReason: "end_turn", usage: { inputTokens: 513807, outputTokens: 120, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 513927 } });
  const answer = await stream.result();
  assert.equal(answer.usage.input, 17341);
  assert.equal(answer.usage.input + answer.usage.cacheRead, answer.usage.totalTokens);
  assert.deepEqual(answer.usage.antigravity.raw, { input: 513807, output: 120, cacheRead: 0, cacheWrite: 0 });
  update(800000);
  const next = h.stream([...history, answer, user("next")]);
  await until(() => connection.prompts.length === 2);
  connection.chunk("continued");
  connection.finish({ stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 5 } });
  const continued = await next.result();
  assert.equal(continued.usage.totalTokens, 25);
  assert.equal(continued.usage.input, 25);
  assert.equal(continued.usage.output, 5);
});

test("Pi MCP routing uses exact guidance and a distinct zero-tool message", async (t) => {
  for (const hasTools of [true, false]) {
    const h = harness(t);
    const { stream, connection } = await started(h, [user("hello")], 0, hasTools ? {} : { toolChoice: "none" });
    const guidance = hasTools
      ? "Use only the Pi tools exposed through MCP. Short tool names in the following instructions refer to their mcp_pi_<name> counterparts."
      : "No Pi tools are available for this request.";
    assert.equal(connection.calls[0].params._meta.antigravity.systemPrompt.append, guidance + "\n\nUse Pi tools only.");
    assert.deepEqual(connection.tools, hasTools ? [tool] : []);
    connection.chunk("done"); connection.finish();
    assert.equal((await stream.result()).stopReason, "stop");
  }
});

test("structured tool references are mapped without changing custom sections, user text or payload overrides", async (t) => {
  for (const override of [false, true]) {
    const h = harness(t);
    const input = "echo({ value: 'user text' })";
    const messages = [{ role: "system", content: "", timestamp: 0, toolsAdded: [tool, { ...tool, name: "mcp_pi_echo" }], sections: {
      tools: "- echo: Echo input\n- mcp_pi_echo: Another tool", rules: "Use echo to repeat text.", skills: "Call `echo`.", custom: "Use echo here.",
    } }, user(input)];
    const stream = h.bridge.streamSimple(model, { messages }, override
      ? { onPayload: payload => ({ ...payload, systemPrompt: "Use echo exactly." }) } : {});
    await until(() => h.connections[0]?.prompts.length > 0);
    const connection = h.connections[0];
    const prompt = connection.calls[0].params._meta.antigravity.systemPrompt.append;
    if (override) {
      assert.match(prompt, /Use echo exactly\./);
      assert.doesNotMatch(prompt, /mcp_pi_echo/);
    } else {
      assert.match(prompt, /- mcp_pi_echo: Echo input/);
      assert.match(prompt, /- mcp_pi_mcp_pi_echo: Another tool/);
      assert.match(prompt, /Use mcp_pi_echo to repeat text\./);
      assert.match(prompt, /Call `mcp_pi_echo`\./);
      assert.match(prompt, /Use echo here\./);
    }
    assert.deepEqual(connection.prompts[0].params.prompt, [{ type: "text", text: input }]);
    connection.chunk("done"); connection.finish();
    assert.equal((await stream.result()).stopReason, "stop");
  }
});

test("Pi default sections are omitted while custom sections and opaque prompts remain exact", async (t) => {
  const preamble = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
  const docs = "<docs>\nPi documentation (read only when asked):\n- Main documentation: /synthetic/pi/README.md\n</docs>";
  for (const kind of ["default", "custom", "opaque"]) {
    const h = harness(t);
    const sections = {
      preamble: preamble + (kind === "custom" ? "\nKeep this custom identity." : ""),
      docs: docs + (kind === "custom" ? "\nKeep this custom guide." : ""),
      rules: "Use echo to repeat text.", custom: "Keep these project constraints.",
    };
    const system = { role: "system", timestamp: 0, toolsAdded: [tool],
      ...(kind === "opaque" ? { content: `${preamble}\n\n${docs}` } : { content: "", sections }) };
    const original = structuredClone(system);
    const stream = h.bridge.streamSimple(model, { messages: [system, user("hello")] }, {});
    await until(() => h.connections[0]?.prompts.length > 0);
    const connection = h.connections[0], append = connection.calls[0].params._meta.antigravity.systemPrompt.append;
    assert.match(append, /^Use only the Pi tools exposed through MCP\./);
    if (kind === "default") {
      assert.ok(!append.includes(preamble));
      assert.ok(!append.includes(docs));
    } else {
      assert.ok(append.includes(kind === "opaque" ? preamble : sections.preamble));
      assert.ok(append.includes(kind === "opaque" ? docs : sections.docs));
    }
    if (kind === "opaque") assert.equal(append.split("\n\n").slice(1).join("\n\n"), system.content);
    else {
      assert.match(append, /Use mcp_pi_echo to repeat text\./);
      assert.ok(append.includes(sections.custom));
    }
    assert.deepEqual(system, original);
    connection.chunk("done"); connection.finish();
    assert.equal((await stream.result()).stopReason, "stop");
  }
});

test("filtered system fingerprints reject old checkpoints and remain stable across default section deltas", async (t) => {
  let saved;
  const h = importFixture(t, { save: state => { saved = structuredClone(state); return true; }, claim: () => true });
  const system = { role: "system", content: "", timestamp: 0, toolsAdded: [tool], sections: {
    preamble: "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
    docs: "<docs>\nPi documentation (read only when asked):\n- Main documentation: /synthetic/pi/README.md\n</docs>",
    custom: "Keep these project constraints.",
  } };
  const messages = [system, user("first")];
  const firstStream = h.bridge.streamSimple(model, { messages }, h.settings);
  await until(() => h.connections[0]?.prompts.length > 0);
  const first = h.connections[0];
  first.chunk("first answer"); first.finish();
  messages.push(await firstStream.result());
  h.bridge.settle();
  const { AGENT_DEFINITION } = await jiti.import(join(CUSTOM, "antigravity/transport.ts"));
  const { HISTORY_IMPORT_POLICY } = await jiti.import(join(CUSTOM, "antigravity/history.ts"));
  const guidance = "Use only the Pi tools exposed through MCP. Short tool names in the following instructions refer to their mcp_pi_<name> counterparts.";
  const fingerprint = prompt => createHash("sha256").update(JSON.stringify([
    AGENT_DEFINITION, HISTORY_IMPORT_POLICY, guidance, CUSTOM, prompt, [tool], h.settings.env, h.root,
  ])).digest("hex");
  assert.equal(saved.configuration, fingerprint(system.sections.custom));
  const legacyConfiguration = fingerprint(ai.getSystemMessageText(system));
  assert.notEqual(saved.configuration, legacyConfiguration);
  h.bridge.reset(); h.bridge.restore({ ...saved, configuration: legacyConfiguration });
  messages.push(user("second"));
  const rebuiltStream = h.bridge.streamSimple(model, { messages }, h.settings);
  await until(() => h.connections[2]?.prompts.length > 0);
  const rebuilt = h.connections[2];
  assert.equal(h.connections[1].calls[0].method, "session/new");
  assert.equal(rebuilt.calls[0].method, "session/resume");
  assert.notEqual(rebuilt.sessionId, first.sessionId);
  rebuilt.chunk("second answer"); rebuilt.finish();
  messages.push(await rebuiltStream.result());
  h.bridge.settle();
  assert.equal(saved.configuration, fingerprint(system.sections.custom));
  h.bridge.reset(); h.bridge.restore(saved);
  messages.push({ role: "system", content: "", timestamp: 1, sections: {
    preamble: null,
    docs: "<docs>\nPi documentation (read only when asked):\n- Main documentation: /synthetic/new-pi/README.md\n</docs>",
  } }, user("third"));
  const resumedStream = h.bridge.streamSimple(model, { messages }, h.settings);
  await until(() => h.connections[3]?.prompts.length > 0);
  const resumed = h.connections[3];
  assert.equal(resumed.calls[0].method, "session/resume");
  assert.equal(resumed.sessionId, rebuilt.sessionId);
  assert.equal(h.databases.length, 1);
  assert.equal(resumed.calls[0].params._meta.antigravity.systemPrompt.append, `${guidance}\n\n${system.sections.custom}`);
  assert.deepEqual(resumed.prompts[0].params.prompt, [{ type: "text", text: "third" }]);
  resumed.chunk("done"); resumed.finish();
  assert.equal((await resumedStream.result()).stopReason, "stop");
});

test("a thinking-only or empty ACP completion is an explicit error, not a silent success", async (t) => {
  for (const thinking of [false, true]) {
    const h = harness(t), { stream, connection } = await started(h, [user("hello")]);
    if (thinking) connection.chunk("planning", "agent_thought_chunk");
    connection.finish();
    const answer = await stream.result();
    assert.equal(answer.stopReason, "error");
    assert.match(answer.errorMessage, /without a text response/);
    assert.equal(connection.closed, true);
  }
});

test("a prompt at the text budget can continue without counting prior history again", { timeout: 3000 }, async (t) => {
  const h = harness(t), history = [user("x".repeat(185_000))];
  const { stream, connection } = await started(h, history);
  connection.chunk("answer"); connection.finish();
  const answer = await stream.result();
  const blocks = [{ type: "text", text: "next" }, { type: "text", text: "part" }];
  const second = h.stream([...history, answer, user(blocks), user("last")]);
  await until(() => connection.prompts.length === 2);
  assert.equal(h.connections.length, 1);
  assert.equal(connection.calls.filter((call) => call.method === "session/new").length, 1);
  assert.deepEqual(connection.prompts[1].params, { sessionId: "session-1", prompt: [
    ...blocks, { type: "text", text: "\n\n" }, { type: "text", text: "last" },
  ] });
  connection.chunk("done"); connection.finish();
  assert.equal((await second.result()).stopReason, "stop");
});

test("completed history resumes with fresh MCP and explicit model/thinking selection", async (t) => {
  let saved;
  const h = harness(t, undefined, { configOptions: [
    { id: "model", category: "model" }, { id: "thinking_level", category: "thought_level" },
  ] }, { save: state => { saved = structuredClone(state); }, claim: () => { saved = undefined; return true; } });
  const history = [user("x".repeat(185_000))];
  const first = await started(h, history, 0, { reasoning: "low" });
  first.connection.chunk("answer"); first.connection.finish();
  history.push(await first.stream.result());
  h.bridge.settle();
  assert.ok(saved);
  h.bridge.reset(); h.bridge.restore(saved);
  const next = await started(h, [...history, user("next")], 1, { reasoning: "high" });
  const setup = next.connection.calls.slice(0, next.connection.calls.findIndex(call => call.method === "session/prompt"));
  assert.equal(setup[0].method, "session/resume");
  assert.equal(next.connection.calls[0].params.sessionId, "session-1");
  assert.deepEqual(next.connection.calls[0].params.mcpServers, [next.connection.mcpServer]);
  assert.notEqual(next.connection.mcpServer.url, first.connection.mcpServer.url);
  assert.equal(setup.find(call => call.params.configId === "model").params.value, model.id);
  assert.equal(setup.find(call => call.params.configId === "thinking_level").params.value, "high");
  assert.deepEqual(next.connection.prompts[0].params.prompt, [{ type: "text", text: "next" }]);
  assert.equal(saved, undefined);
  next.connection.chunk("continued"); next.connection.finish();
  assert.equal((await next.stream.result()).stopReason, "stop");
});

test("legacy default-agent checkpoint configuration never resumes under the Pi agent", async (t) => {
  let saved;
  const h = importFixture(t, { save: state => { saved = structuredClone(state); } });
  const history = [user("legacy history")];
  const first = await started(h, history, 0, h.settings);
  first.connection.chunk("answer"); first.connection.finish();
  history.push(await first.stream.result());
  h.bridge.settle();
  const legacyConfiguration = createHash("sha256").update(JSON.stringify(["pi", CUSTOM, "Use Pi tools only.", [tool], undefined])).digest("hex");
  assert.notEqual(saved.configuration, legacyConfiguration);
  h.bridge.reset(); h.bridge.restore({ ...saved, configuration: legacyConfiguration });
  const next = await started(h, [...history, user("next")], 2, h.settings);
  assert.equal(h.connections[1].calls[0].method, "session/new");
  assert.equal(next.connection.calls[0].method, "session/resume");
  assert.notEqual(next.connection.sessionId, first.connection.sessionId);
  assert.deepEqual(next.connection.prompts[0].params.prompt, [{ type: "text", text: "next" }]);
  next.connection.chunk("done"); next.connection.finish();
  assert.equal((await next.stream.result()).stopReason, "stop");
});

test("a shared checkpoint is consumed once, including by its original live bridge", async (t) => {
  let saved;
  const options = {
    save(state) { saved = structuredClone(state); return true; },
    claim(state) {
      const accepted = JSON.stringify(saved) === JSON.stringify(state);
      saved = undefined;
      return accepted;
    },
  };
  const first = importFixture(t, options), history = [user("first")];
  const original = await started(first, history, 0, first.settings);
  original.connection.chunk("answer"); original.connection.finish();
  history.push(await original.stream.result());
  first.bridge.settle();
  const connecting = deferred();
  const other = harness(t, undefined, {}, { ...options, connectionReady: () => connecting.promise });
  other.bridge.restore(saved);
  const resumedPromise = started(other, [...history, user("other")], 0, first.settings);
  await until(() => other.connections.length === 1);
  other.bridge.settle();
  assert.equal(saved, undefined);
  connecting.resolve();
  const resumed = await resumedPromise;
  assert.equal(resumed.connection.calls[0].method, "session/resume");
  first.bridge.settle();
  assert.equal(saved, undefined);
  const replaced = await started(first, [...history, user("original")], 2, first.settings);
  assert.equal(first.connections[1].calls[0].method, "session/new");
  assert.equal(replaced.connection.calls[0].method, "session/resume");
  assert.notEqual(replaced.connection.sessionId, original.connection.sessionId);
  assert.equal(original.connection.closed, true);
  for (const turn of [resumed, replaced]) {
    turn.connection.chunk("done"); turn.connection.finish();
    assert.equal((await turn.stream.result()).stopReason, "stop");
  }
});

test("changed history uses a new session and failed prompts discard the checkpoint", async (t) => {
  let saved;
  const h = importFixture(t, { save: state => { saved = structuredClone(state); }, claim: () => { saved = undefined; return true; } });
  const first = await started(h, [user("first")], 0, h.settings);
  first.connection.chunk("answer"); first.connection.finish();
  const answer = await first.stream.result();
  h.bridge.settle();
  h.bridge.reset(); h.bridge.restore(saved);
  const next = await started(h, [user("edited"), answer, user("next")], 2, h.settings);
  assert.equal(h.connections[1].calls[0].method, "session/new");
  assert.equal(next.connection.calls[0].method, "session/resume");
  assert.deepEqual(next.connection.prompts[0].params.prompt, [{ type: "text", text: "next" }]);
  assert.equal(saved, undefined);
  next.connection.prompts[0].reject(new Error("Connection lost after sending"));
  assert.equal((await next.stream.result()).stopReason, "error");
  h.bridge.settle();
  assert.equal(saved, undefined);
  assert.equal(h.connections.length, 3);
  assert.equal(next.connection.prompts.length, 1);
});

test("full calibrated windows admit ASCII and Chinese input without subtracting reserve twice", { timeout: 10000 }, async (t) => {
  const { SettingsManager } = await jiti.import(join(PI_PACKAGE, "dist/index.js"));
  const { catalogModel } = await jiti.import(join(CUSTOM, "antigravity/catalog.ts"));
  const systemTokens = estimateMessageTokens({ role: "system", content: "Use only the Pi tools exposed through MCP. Short tool names in the following instructions refer to their mcp_pi_<name> counterparts.\n\nUse Pi tools only.",
    toolsAdded: [{ ...tool, name: "mcp_pi_echo" }], timestamp: 0 });
  for (const id of ["gemini-4-hydrogen", "gemini-4-neon"]) for (const unit of ["x", "汉字🧪"]) {
    const selected = { ...model, id, contextWindow: catalogModel(id).contextWindow };
    assert.equal(SettingsManager.inMemory({}).getCompactionSettings(selected).reserveTokens, 16384);
    const text = fitInputBudget(unit, selected.contextWindow - systemTokens);
    const h = importFixture(t, { independent: unit !== "x" });
    const input = value => ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools: [tool], messages: [user(value)] });
    const stream = h.bridge.streamSimple(selected, input(text), h.settings);
    await until(() => h.connections[1]?.prompts.length);
    const active = h.connections[1];
    const chunks = [...importedRows(h.databases[0]).map(row => nativeField(row.step_payload, 19, 2).toString()), active.prompts[0].params.prompt[0].text];
    assert.equal(chunks.join(""), text);
    active.chunk("Done"); active.finish();
    assert.equal((await stream.result()).stopReason, "stop");
    const over = await h.bridge.streamSimple(selected, input(text + "x"), h.settings).result();
    assert.equal(over.errorMessage, "Antigravity prompt is too long. Shorten the input or use another model.");
    assert.equal(ai.isContextOverflow(over), true);
    assert.equal(h.connections.length, 2);
    assert.equal(active.prompts.length, 1);
  }
});

test("summary admission counts bounded tool results, image placeholders and native error framing rather than old usage", { timeout: 10000 }, async (t) => {
  const { boundedToolResultText } = await jiti.import(join(CUSTOM, "antigravity/history.ts"));
  const selected = { ...model, contextWindow: 256000 };
  const call = { role: "assistant", content: [{ type: "toolCall", id: "past", name: "echo", arguments: { value: "past" } }], stopReason: "toolUse", usage: { totalTokens: 999999999 }, timestamp: 0 };
  const result = { role: "toolResult", toolCallId: "past", toolName: "echo", isError: true,
    content: [{ type: "text", text: "r".repeat(1000000) }, { type: "image", mimeType: "image/png", data: "AA==" }], timestamp: 0 };
  const system = { role: "system", content: "Use only the Pi tools exposed through MCP. Short tool names in the following instructions refer to their mcp_pi_<name> counterparts.\n\nUse Pi tools only.",
    toolsAdded: [{ ...tool, name: "mcp_pi_echo" }], timestamp: 0 };
  const fixed = estimateMessageTokens(system) + estimateMessageTokens({ ...call, content: [{ ...call.content[0], name: "mcp_pi_echo" }] })
    + estimateMessageTokens({ ...result, content: [{ type: "text", text: "Encountered error in tool execution: " + boundedToolResultText(result.content[0].text + "\n[Pi omitted an image]", true) }] })
    + estimateMessageTokens(user("Write the summary now."));
  const messages = [user(fitInputBudget("p", selected.contextWindow - fixed)), call, result, user("Write the summary now.")];
  const h = importFixture(t, { independent: true });
  const input = () => ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools: [tool], messages });
  const stream = h.bridge.streamSimple(selected, input(), h.settings);
  await until(() => h.connections[1]?.prompts.length);
  h.connections[1].chunk("Summary"); h.connections[1].finish();
  assert.equal((await stream.result()).stopReason, "stop");
  messages[0].content += "x";
  const over = await h.bridge.streamSimple(selected, input(), h.settings).result();
  assert.equal(ai.isContextOverflow(over), true);
  assert.equal(h.connections[1].prompts.length, 1);
});

test("admission overflow after tool delivery stops without releasing its result or retrying", async (t) => {
  const h = harness(t), messages = [user("tool")];
  const { stream, connection } = await started(h, messages);
  const reply = connection.handlers.tool("echo", { value: "done" });
  const answer = await stream.result();
  const rejected = assert.rejects(reply, /prompt is too long/);
  const result = { role: "toolResult", toolCallId: answer.content[0].id, toolName: "echo", isError: false, content: [{ type: "text", text: "r".repeat(100000) }] };
  const failed = await h.bridge.streamSimple({ ...model, contextWindow: 1000 }, ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools: [tool], messages: [...messages, answer, result] })).result();
  await rejected;
  assert.equal(failed.stopReason, "aborted");
  assert.equal(ai.isContextOverflow(failed), false);
  assert.equal(ai.isRetryableAssistantError(failed), false);
  assert.equal(connection.prompts.length, 1);
  assert.equal(connection.closed, true);
});

test("oversized mixed images and full-history overflow fail before opening a target", async (t) => {
  for (const independent of [false, true]) for (const messages of [
    [user([{ type: "text", text: "x".repeat(185001) }, { type: "image", mimeType: "image/png", data: "AA==" }])],
    [user("x".repeat(185000)), { role: "assistant", content: [{ type: "text", text: "y".repeat(model.contextWindow * 4) }], stopReason: "stop" }, user("z".repeat(185001))],
    [user("x".repeat(model.contextWindow * 4 + 1))],
  ]) {
    const h = importFixture(t, { independent });
    const answer = await h.stream(messages, h.settings).result();
    assert.equal(answer.stopReason, "error");
    assert.equal(answer.errorMessage, "Antigravity prompt is too long. Shorten the input or use another model.");
    assert.equal(ai.isContextOverflow(answer), true);
    assert.equal(ai.isRetryableAssistantError(answer), false);
    assert.equal(h.connections.length, 0);
    assert.equal(h.databases.length, 0);
  }
});

test("policy changes import history into a new session and send only the user suffix", { timeout: 3000 }, async (t) => {
  const h = importFixture(t), history = [user("first")];
  const { stream, connection } = await started(h, history, 0, h.settings);
  connection.chunk("answer"); connection.finish();
  const messages = [...history, await stream.result(), user("next")];
  const next = await started(h, messages, 2, h.settings, "Require approval.");
  assert.equal(connection.closed, true);
  assert.match(next.connection.calls[0].params._meta.antigravity.systemPrompt.append, /Require approval\./);
  const prompt = next.connection.prompts[0].params.prompt;
  assert.equal(next.connection.calls[0].method, "session/resume");
  assert.equal(importedRows(h.databases[0]).length, 2);
  assert.deepEqual(prompt, [{ type: "text", text: "next" }]);
  next.connection.chunk("continued"); next.connection.finish();
  assert.equal((await next.stream.result()).stopReason, "stop");
});

test("unimportable history fails explicitly before opening a connection", async (t) => {
  for (const kind of ["owner", "root", "assistant", "toolResult"]) {
    const h = importFixture(t, kind === "owner" ? { piSessionId: () => undefined } : {});
    const messages = importedHistory();
    let expected;
    if (kind === "owner") expected = "Antigravity history import requires a Pi session ID.";
    else if (kind === "root") expected = "Antigravity history storage is unavailable.";
    else if (kind === "assistant") {
      messages.pop();
      expected = "Antigravity cannot import this history. Compact with another model or start a new conversation.";
    } else {
      messages.push({ role: "toolResult", toolCallId: "orphan", toolName: "echo", content: [{ type: "text", text: "done" }], isError: false });
      expected = "Antigravity cannot resume from a tool result. Send a new message to continue.";
    }
    const settings = kind === "root" ? { env: { GEMINI_HOME: join(h.root, "missing") } } : h.settings;
    const answer = await h.stream(messages, settings).result();
    assert.equal(answer.errorMessage, expected, kind);
    assert.equal(h.connections.length, 0, kind);
    assert.equal(h.databases.length, 0, kind);
  }
});

test("a terminal prompt during the tool gap rejects all parked calls and cannot reset its successor", { timeout: 3000 }, async (t) => {
  for (const stopReason of ["cancelled", "end_turn"]) {
    const h = harness(t), first = await started(h, [user("tool")]);
    const pending = first.connection.handlers.tool("echo", { value: "first" }).then(() => null, error => error);
    const extra = first.connection.handlers.tool("echo", { value: "second" }).then(() => null, error => error);
    assert.equal((await first.stream.result()).stopReason, "toolUse");
    first.connection.finish({ stopReason });
    await tick(); await tick();
    assert.equal(first.connection.closed, true);
    assert.match((await pending).message, /cancelled|pending/);
    assert.match((await extra).message, /cancelled|pending/);
    h.bridge.settle();
    const next = await started(h, [user("fresh")], 1);
    first.connection.chunk("stale");
    first.connection.finish({ stopReason: "cancelled" });
    next.connection.chunk("fresh"); next.connection.finish();
    assert.deepEqual((await next.stream.result()).content, [{ type: "text", text: "fresh" }]);
  }
});

test("a parked MCP request emits a Pi tool call and resumes only with its transcript result", { timeout: 3000 }, async (t) => {
  const h = harness(t), history = [user("use echo")];
  const { stream, connection } = await started(h, history, 0, { timeoutMs: 80 });
  assert.equal(connection.prompts[0].settings?.timeoutMs, 80);
  connection.chunk("before "); connection.chunk("tool");
  let released = false;
  const pending = connection.handlers.tool("echo", { value: "hello" }).then((value) => { released = true; return value; });
  const answer = await stream.result();
  assert.equal(answer.stopReason, "toolUse");
  assert.equal(answer.usage.totalTokens, 1);
  connection.handlers.update({ sessionId: connection.sessionId, update: { sessionUpdate: "usage_update", used: 23 } });
  assert.equal(released, false);
  assert.deepEqual(answer.content[0], { type: "text", text: "before tool" });
  const call = answer.content[1];
  assert.ok(typeof call.id === "string" && call.id.length > 0);
  assert.deepEqual({ ...call, id: "fixture" }, { type: "toolCall", id: "fixture", name: "echo", arguments: { value: "hello" } });
  const events = []; for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ["start", "text_start", "text_delta", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
  const result = { role: "toolResult", toolCallId: call.id, toolName: "echo", content: [{ type: "text", text: "echoed" }], isError: false, timestamp: 0 };
  const next = h.stream([...history, answer, result], { timeoutMs: 120 });
  assert.deepEqual(await pending, { content: result.content, isError: false });
  assert.deepEqual(connection.watchdogs, [{ sessionId: "session-1", settings: { timeoutMs: 120 } }]);
  assert.equal(h.connections.length, 1);
  assert.equal(connection.prompts.length, 1);
  connection.chunk("finished"); connection.finish();
  const final = await next.result();
  assert.equal(final.stopReason, "stop");
  const independentFailure = await h.stream([...history, answer, result, final, user("next")], {
    onPayload: () => { throw new Error("503 overloaded"); },
  }).result();
  assert.equal(independentFailure.stopReason, "error");
  assert.equal(ai.isRetryableAssistantError(independentFailure), true);
  assert.deepEqual(final.content, [{ type: "text", text: "finished" }]);
  assert.equal(final.usage.totalTokens, 23);
  assert.equal(final.usage.input + final.usage.cacheRead, 23);
});

test("changing thinking during a tool gap rejects rebuilding from its tool result", async (t) => {
  const h = harness(t, undefined, { configOptions: [{ id: "thinking_level", category: "thought_level" }] });
  const history = [user("use echo")];
  const first = await started(h, history, 0, { reasoning: "low" });
  const pending = first.connection.handlers.tool("echo", { value: "hello" }).catch(error => error);
  const answer = await first.stream.result();
  const result = { role: "toolResult", toolCallId: answer.content[0].id, toolName: "echo", content: [{ type: "text", text: "done" }] };
  const next = await h.stream([...history, answer, result], { reasoning: "high" }).result();
  assert.ok(await pending instanceof Error);
  assert.equal(first.connection.closed, true);
  assert.equal(next.errorMessage, "Antigravity cannot resume from a tool result. Send a new message to continue.");
  assert.equal(h.connections.length, 1);
  assert.equal(first.connection.prompts.length, 1);
});

test("an interrupted prompt aborts the tool-result continuation without retrying", { timeout: 3000 }, async (t) => {
  for (const phase of ["tool-gap", "continuation", "queued-hook"]) {
    const beforeContinuation = phase === "tool-gap";
    const h = harness(t), history = [user("use echo")];
    const { stream, connection } = await started(h, history);
    const pending = connection.handlers.tool("echo", { value: "hello" }).catch(error => error);
    const answer = await stream.result();
    const result = { role: "toolResult", toolCallId: answer.content[0].id, toolName: "echo", content: [{ type: "text", text: "done" }], isError: false, timestamp: 0 };
    const interrupt = () => connection.prompts[0].reject(new DOMException("ACP output closed", "AbortError"));
    const payload = deferred(), hook = deferred();
    const next = h.stream([...history, answer, result, ...(beforeContinuation ? [user("steering")] : [])], {
      ...(beforeContinuation ? { onPayload: () => payload.promise } : {}),
      ...(phase === "queued-hook" ? { onProviderStreamEvent: () => hook.promise } : {}),
    });
    if (beforeContinuation) {
      await tick(); interrupt(); await pending; payload.resolve();
    } else {
      await pending;
      if (phase === "queued-hook") {
        connection.chunk("completed"); connection.finish(); await tick();
        hook.reject(new Error("Hook timed out"));
      } else interrupt();
    }
    const failure = await next.result();
    assert.equal(failure.stopReason, "aborted");
    assert.equal(failure.errorMessage, phase === "queued-hook" ? "Hook timed out" : "ACP output closed");
    assert.equal(ai.isRetryableAssistantError(failure), false);
    assert.equal(connection.closed, true);
    assert.equal(h.connections.length, 1);
    assert.equal(connection.prompts.length, 1);
    const events = []; for await (const event of next) events.push(event.type);
    assert.deepEqual(events, beforeContinuation ? ["error"] : ["start", "error"]);
  }
});

test("failures after tool delivery cannot trigger retry or overflow recovery", { timeout: 3000 }, async (t) => {
  for (const phase of ["tool-gap", "continuation", "length", "payload"]) {
    const h = harness(t), history = [user("use echo")];
    const { stream, connection } = await started(h, history);
    const pending = connection.handlers.tool("echo", { value: "side effect" }).catch(error => error);
    const answer = await stream.result();
    const result = { role: "toolResult", toolCallId: answer.content[0].id, toolName: "echo", content: [{ type: "text", text: "done" }], isError: false, timestamp: 0 };
    if (phase === "tool-gap") {
      connection.prompts[0].reject(new Error("prompt is too long"));
      await pending;
    }
    const next = h.stream([...history, answer, result], phase === "payload" ? {
      onPayload: () => { throw new Error("503 overloaded: prompt is too long"); },
    } : {});
    if (phase !== "tool-gap" && phase !== "payload") {
      await pending;
      if (phase === "length") { connection.chunk("partial"); connection.finish({ stopReason: "max_tokens" }); }
      else connection.prompts[0].reject(new Error("503 overloaded"));
    }
    const failure = await next.result();
    assert.equal(failure.stopReason, "aborted", phase);
    if (phase === "payload") assert.ok(await pending instanceof Error);
    assert.equal(ai.isRetryableAssistantError(failure), false);
    assert.equal(ai.isContextOverflow(failure, model.contextWindow), false);
    assert.equal(ai.isRecoverableLength(failure, model.maxTokens), false);
    assert.equal(connection.closed, true);
    assert.equal(h.connections.length, 1);
    assert.equal(connection.prompts.length, 1);
  }
});

test("a late tool-gap payload failure cannot reset another continuation or the next prompt", async (t) => {
  for (const phase of ["same-prompt", "next-prompt", "resolved-next-tool"]) {
    const h = harness(t), messages = [user("tool")];
    const { stream, connection } = await started(h, messages);
    const reply = connection.handlers.tool("echo", { value: "done" });
    const toolAnswer = await stream.result();
    messages.push(toolAnswer, { role: "toolResult", toolCallId: toolAnswer.content[0].id, toolName: "echo", content: [{ type: "text", text: "done" }] });
    const payload = deferred();
    const late = h.stream(messages, { onPayload: () => payload.promise });
    let current = h.stream(messages);
    await reply;
    if (phase !== "same-prompt") {
      connection.chunk("first completed"); connection.finish();
      messages.push(await current.result(), user("next"));
      current = h.stream(messages);
      await until(() => connection.prompts.length === 2);
    }
    let nextReply, nextTool;
    if (phase === "resolved-next-tool") {
      nextReply = connection.handlers.tool("echo", { value: "second prompt" });
      nextTool = await current.result();
      payload.resolve(undefined);
    } else payload.reject(new Error("503 overloaded"));
    assert.equal((await late.result()).stopReason, "aborted");
    assert.equal(connection.closed, false, phase);
    if (nextTool) {
      current = h.stream([...messages, nextTool, { role: "toolResult", toolCallId: nextTool.content[0].id, toolName: "echo", content: [{ type: "text", text: "second done" }] }]);
      assert.deepEqual(await nextReply, { content: [{ type: "text", text: "second done" }], isError: undefined });
    }
    connection.chunk("completed"); connection.finish();
    assert.equal((await current.result()).stopReason, "stop", phase);
    assert.equal(h.connections.length, 1);
  }
});

test("an update awaiting its hook cannot write into a new stream after reset", { timeout: 3000 }, async (t) => {
  const h = harness(t), hook = deferred();
  let entered = false;
  const first = await started(h, [user("first")], 0, { onProviderStreamEvent: async () => { entered = true; await hook.promise; } });
  first.connection.handlers.update({ sessionId: first.connection.sessionId, update: { sessionUpdate: "usage_update", used: 999 } });
  first.connection.chunk("stale");
  await until(() => entered);
  h.bridge.reset();
  assert.equal((await first.stream.result()).stopReason, "error");
  const next = await started(h, [user("next")], 1);
  hook.resolve();
  await tick();
  first.connection.finish();
  next.connection.chunk("fresh"); next.connection.finish({ stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 1 } });
  const answer = await next.stream.result();
  assert.deepEqual(answer.content, [{ type: "text", text: "fresh" }]);
  assert.equal(answer.usage.totalTokens, 8);
  const deltas = []; for await (const event of next.stream) if (event.type === "text_delta") deltas.push(event.delta);
  assert.deepEqual(deltas, ["fresh"]);
});

test("abort closes the transport and ignores late updates before starting a fresh session", { timeout: 3000 }, async (t) => {
  const h = harness(t), controller = new AbortController();
  const { stream, connection } = await started(h, [user("wait")], 0, { signal: controller.signal });
  controller.abort();
  assert.equal((await stream.result()).stopReason, "aborted");
  assert.equal(connection.closed, true);
  const next = await started(h, [user("retry")], 1);
  connection.chunk("stale"); connection.finish();
  next.connection.chunk("fresh"); next.connection.finish();
  assert.deepEqual((await next.stream.result()).content, [{ type: "text", text: "fresh" }]);
});

for (const action of ["abort", "reset"]) test(`${action} during the tool gap rejects the parked MCP request`, { timeout: 3000 }, async (t) => {
  const h = harness(t), controller = new AbortController();
  const { stream, connection } = await started(h, [user("tool")], 0, { signal: controller.signal });
  const pending = connection.handlers.tool("echo", { value: "hello" });
  // Observe rejection immediately, including cleanup after a failed assertion.
  const outcome = pending.then((value) => ({ value }), (error) => ({ error }));
  assert.equal((await stream.result()).stopReason, "toolUse");
  if (action === "abort") controller.abort(); else h.bridge.reset();
  await until(() => connection.closed);
  assert.match((await outcome).error.message, /aborted|session context changed/);
  connection.finish();
});

test("missing system-prompt or HTTP MCP support fails before session creation", { timeout: 3000 }, async (t) => {
  for (const [initialized, error] of [
    [{}, /systemPrompt\.append/],
    [{ agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: false } } } } }, /systemPrompt\.append/],
    [{ agentCapabilities: { ...agentCapabilities, mcpCapabilities: undefined } }, /HTTP MCP/],
    [{ agentCapabilities: { ...agentCapabilities, mcpCapabilities: { http: false } } }, /HTTP MCP/],
  ]) {
    const h = harness(t, initialized);
    const answer = await h.stream([user("hello")]).result();
    assert.equal(answer.stopReason, "error");
    assert.match(answer.errorMessage, error);
    assert.equal(h.connections.length, 1);
    assert.equal(h.connections[0].closed, true);
    assert.deepEqual(h.connections[0].calls, []);
  }
});

test("prompt capabilities are required only for the content actually sent", async (t) => {
  const image = [user([{ type: "image", mimeType: "image/png", data: "IMAGE" }])];
  for (const [messages, promptCapabilities, error] of [
    [image, {}, /image prompts/],
    [image, { image: true }, null],
    [[user("next")], {}, null],
  ]) {
    const h = harness(t, { agentCapabilities: { ...agentCapabilities, promptCapabilities } });
    const stream = h.stream(messages);
    if (error) {
      const answer = await stream.result();
      assert.equal(answer.stopReason, "error");
      assert.match(answer.errorMessage, error);
      assert.equal(h.connections[0].prompts.length, 0);
      assert.equal(h.connections[0].closed, true);
    } else {
      await until(() => h.connections[0]?.prompts.length > 0);
      h.connections[0].chunk("done"); h.connections[0].finish();
      assert.equal((await stream.result()).stopReason, "stop");
    }
  }
});

test("small history imports without embedded-context prompt support or a loss notification", async (t) => {
  const h = importFixture(t, { onImport: () => assert.fail("Lossless imports must not notify"), initialized: () => ({
    agentCapabilities: { ...agentCapabilities, promptCapabilities: {} }, agentInfo: { version: "1.5.15" },
  }) });
  const next = await started(h, importedHistory(), 1, h.settings);
  assert.equal(importedRows(h.databases[0]).length, 2);
  assert.deepEqual(next.connection.prompts[0].params.prompt, [{ type: "text", text: "new request" }]);
  next.connection.chunk("done"); next.connection.finish();
  assert.equal((await next.stream.result()).stopReason, "stop");
});

test("an explicit unmatched request owner cannot receive an import notice from the fallback bridge", async (t) => {
  const h = importFixture(t, { onImport: () => assert.fail("Unmatched request owners must not notify") });
  const messages = importedHistory();
  messages[0].content = "x".repeat(200_000);
  const next = await started(h, messages, 1, { ...h.settings, sessionId: randomUUID() });
  assert.equal(h.databases.length, 1);
  assert.equal(next.connection.calls[0].method, "session/resume");
  assert.deepEqual(next.connection.prompts[0].params.prompt, [{ type: "text", text: "new request" }]);
  next.connection.chunk("done"); next.connection.finish();
  assert.equal((await next.stream.result()).stopReason, "stop");
});

test("failed current image validation does not notify losses from the imported history", async (t) => {
  const h = importFixture(t, { onImport: () => assert.fail("Invalid prompts must not notify"), initialized: () => ({
    agentCapabilities: { ...agentCapabilities, promptCapabilities: {} }, agentInfo: { version: "1.5.15" },
  }) });
  const messages = importedHistory();
  messages[0].content = "x".repeat(185001);
  messages.at(-1).content = [{ type: "image", mimeType: "image/png", data: "AA==" }];
  const result = await h.stream(messages, h.settings).result();
  assert.match(result.errorMessage, /does not support image prompts/);
  assert.equal(importedRows(h.databases[0]).length, 3);
  assert.equal(h.connections[1].prompts.length, 0);
});

test("selected catalog IDs reach modern and legacy ACP model selection before prompting", async (t) => {
  for (const modern of [true, false]) {
    const h = harness(t, undefined, modern ? { configOptions: [{ id: "model_id", category: "model", type: "select" }] } : {});
    const stream = h.bridge.streamSimple({ ...model, id: "advertised-id" }, ai.normalizeContext({ systemPrompt: "Use Pi tools.", tools: [tool], messages: [user("hello")] }));
    await until(() => h.connections[0]?.prompts.length > 0);
    const connection = h.connections[0];
    assert.deepEqual(connection.calls[1], modern
      ? { method: "session/set_config_option", params: { sessionId: "session-1", configId: "model_id", value: "advertised-id" } }
      : { method: "session/set_model", params: { sessionId: "session-1", modelId: "advertised-id" } });
    connection.chunk("hello"); connection.finish();
    assert.equal((await stream.result()).stopReason, "stop");
  }
});

test("provider registration routes requests to their Pi session and isolates lifecycle resets", (t) => {
  const registry = globalThis[Symbol.for("pi-custom:antigravity-bridges")];
  const register = (id) => {
    const handlers = new Map();
    let provider;
    registerAntigravity({ registerProvider(name, value) { assert.equal(name, "antigravity"); provider = value; }, on(name, handler) { handlers.set(name, handler); } });
    handlers.get("session_start")({}, { cwd: CUSTOM, sessionManager: { getSessionId: () => id } });
    const bridge = registry.get(id), calls = [], resets = [];
    bridge.streamSimple = (...args) => { calls.push(args); return id; };
    bridge.reset = () => resets.push(true);
    t.after(() => handlers.get("session_shutdown")());
    return { handlers, provider, calls, resets };
  };
  const a = register("antigravity-test-a"), b = register("antigravity-test-b");
  assert.equal(b.provider.streamSimple(model, { messages: [] }, { sessionId: "antigravity-test-a" }), "antigravity-test-a");
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 0);
  assert.equal(b.provider.streamSimple(model, { messages: [] }, { sessionId: "antigravity-test-b" }), "antigravity-test-b");
  a.handlers.get("session_tree")();
  assert.equal(a.resets.length, 1);
  assert.equal(b.resets.length, 0);
  a.handlers.get("session_shutdown")();
  assert.equal(registry.has("antigravity-test-a"), false);
  assert.equal(registry.has("antigravity-test-b"), true);
  assert.equal(b.provider.streamSimple(model, { messages: [] }, { sessionId: "antigravity-test-b" }), "antigravity-test-b");
  assert.equal(b.calls.length, 2);
  assert.equal(b.provider.streamSimple(model, { messages: [] }), "antigravity-test-b");
  assert.equal(b.calls.length, 3);
});

test("one-token warming requests are rejected before opening a connection", async (t) => {
  const h = harness(t);
  const answer = await h.stream([user("warm")], { maxTokens: 1, disableContinuation: true }).result();
  assert.equal(answer.errorMessage, "Antigravity ACP does not support cache-warming replays");
  assert.equal(h.connections.length, 0);
});

test("disabled continuation bypasses a registered bridge before touching its state", async (t) => {
  const handlers = new Map(), id = randomUUID();
  let provider;
  registerAntigravity({ registerProvider(name, value) { provider = value; }, on(name, handler) { handlers.set(name, handler); } });
  handlers.get("session_start")({}, { cwd: CUSTOM, sessionManager: { getSessionId: () => id } });
  t.after(() => handlers.get("session_shutdown")());
  const bridge = globalThis[Symbol.for("pi-custom:antigravity-bridges")].get(id);
  let calls = 0, resets = 0;
  bridge.streamSimple = () => { calls++; throw new Error("Main bridge must not receive the independent request"); };
  bridge.reset = () => { resets++; };
  const stream = provider.streamSimple(model, { messages: [] }, {
    sessionId: id, disableContinuation: true, fetch: () => { throw new Error("No network expected"); },
  });
  const answer = await stream.result();
  assert.equal(answer.errorMessage, "Antigravity ACP cannot use custom fetch");
  assert.equal(calls, 0);
  assert.equal(resets, 0);
  assert.equal(globalThis[Symbol.for("pi-custom:antigravity-bridges")].get(id), bridge);
});

for (const disableContinuation of [false, true]) test(`${disableContinuation ? "Disabled continuation" : "Unknown routing IDs"} uses disposable bridges without interrupting the main tool gap`, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-agy-disposable-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stub = join(directory, "bridge.cjs");
  writeFileSync(stub, "exports.PROVIDER_ID='antigravity'; exports.createAntigravityBridge=options=>exports.factory(options);");
  const instances = [];
  require(stub).factory = options => {
    const h = harness(t, undefined, {}, options);
    instances.push({ ...h, options });
    return h.bridge;
  };
  const isolated = createJiti(__filename, { moduleCache: false, alias: {
    "./antigravity/bridge.js": stub,
    "@earendil-works/pi-ai/compat": join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
  } });
  const { registerAntigravity: register } = await isolated.import(join(CUSTOM, "antigravity.ts"));
  const handlers = new Map(), owner = randomUUID();
  let provider;
  register({ registerProvider(name, value) { provider = value; }, on(name, handler) { handlers.set(name, handler); } });
  handlers.get("session_start")({}, { cwd: CUSTOM, sessionManager: {
    getSessionId: () => owner, getSessionFile: () => undefined, getLeafId: () => undefined,
  } });
  t.after(() => handlers.get("session_shutdown")());
  const request = (id, messages, options = {}) => provider.streamSimple(model,
    ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools: [tool], messages }), { ...options, sessionId: id });
  const main = instances[0], original = [user("main request")];
  const first = request(owner, original);
  await until(() => main.connections[0]?.prompts.length);
  const connection = main.connections[0];
  let toolSettled = false;
  const toolReply = connection.handlers.tool("echo", { value: "main result" });
  void toolReply.then(() => { toolSettled = true; }, () => { toolSettled = true; });
  const assistant = await first.result(), call = assistant.content.find(block => block.type === "toolCall");
  for (const outcome of ["stop", "error", "aborted"]) {
    const controller = new AbortController(), id = disableContinuation ? owner : randomUUID();
    const auxiliary = request(id, [user("auxiliary request")], { signal: controller.signal, disableContinuation });
    assert.equal(instances.length, 2 + ["stop", "error", "aborted"].indexOf(outcome));
    const temporary = instances.at(-1);
    assert.equal(temporary.options.piSessionId(), id);
    assert.equal(temporary.options.independent, true);
    assert.equal(globalThis[Symbol.for("pi-custom:antigravity-bridges")].has(id), disableContinuation);
    for (const hook of ["save", "claim", "onImport"]) assert.equal(temporary.options[hook], undefined);
    await until(() => temporary.connections[0]?.prompts.length);
    if (outcome === "error") temporary.connections[0].prompts[0].reject(new Error("Synthetic backend error"));
    else if (outcome === "aborted") controller.abort();
    else { temporary.connections[0].chunk("auxiliary answer"); temporary.connections[0].finish(); }
    assert.equal((await auxiliary.result()).stopReason, outcome);
    await tick();
    assert.equal(temporary.connections[0].closed, true);
    assert.equal(connection.closed, false);
    assert.equal(toolSettled, false);
    assert.equal(main.connections.length, 1);
  }
  const continued = request(owner, [...original, assistant,
    { role: "toolResult", toolCallId: call.id, toolName: "echo", isError: false, content: [{ type: "text", text: "main result" }], timestamp: 0 }]);
  assert.deepEqual(await toolReply, { content: [{ type: "text", text: "main result" }], isError: false });
  connection.chunk("main answer"); connection.finish();
  assert.equal((await continued.result()).stopReason, "stop");
  assert.equal(main.connections.length, 1);
  assert.equal(connection.prompts.length, 1);
  const pending = request(randomUUID(), [user("pending auxiliary")]);
  const temporary = instances.at(-1);
  await until(() => temporary.connections[0]?.prompts.length);
  handlers.get("session_shutdown")();
  assert.equal((await pending.result()).stopReason, "error");
  assert.equal(temporary.connections[0].closed, true);
});

test("independent requests without a routing ID can import history without continuation persistence", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-agy-independent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stub = join(directory, "bridge.cjs"), instances = [];
  writeFileSync(stub, "exports.PROVIDER_ID='antigravity'; exports.createAntigravityBridge=options=>exports.factory(options);");
  require(stub).factory = options => {
    const h = importFixture(t, options);
    instances.push({ ...h, options });
    return h.bridge;
  };
  const isolated = createJiti(__filename, { moduleCache: false, alias: {
    "./antigravity/bridge.js": stub,
    "@earendil-works/pi-ai/compat": join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
  } });
  const { registerAntigravity: register } = await isolated.import(join(CUSTOM, "antigravity.ts"));
  let provider;
  register({ registerProvider(name, value) { provider = value; }, on() {} });
  const stream = provider.streamSimple(model, ai.normalizeContext({ messages: importedHistory() }), {
    disableContinuation: true, ...instances[0].settings,
  });
  const temporary = instances[1];
  assert.match(temporary.options.piSessionId(), /^[0-9a-f-]{36}$/);
  for (const hook of ["save", "claim", "onImport"]) assert.equal(temporary.options[hook], undefined);
  await until(() => temporary.connections[1]?.prompts.length);
  assert.equal(temporary.connections[1].calls[0].method, "session/resume");
  temporary.connections[1].chunk("summary"); temporary.connections[1].finish();
  assert.equal((await stream.result()).stopReason, "stop");
  await tick();
  assert.equal(temporary.connections[1].closed, true);
  assert.equal(instances[0].connections.length, 0);
});

test("non-durable Pi sessions retain ownership and route import notices only to their own UI", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-agy-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stub = join(root, "bridge.cjs");
  writeFileSync(stub, `exports.PROVIDER_ID = 'antigravity';
exports.options = [];
exports.createAntigravityBridge = options => {
  exports.options.push(options);
  return { reset() {}, restore() {}, settle() {},
    streamSimple(model, transcript, request) { options.onImport(request.losses); return options.piSessionId(); }
  };
};`);
  const isolated = createJiti(__filename, { moduleCache: false, alias: {
    "./antigravity/bridge.js": stub,
    "@earendil-works/pi-ai/compat": join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
  } });
  const { registerAntigravity: register } = await isolated.import(join(CUSTOM, "antigravity.ts"));
  const registerSession = (hasUI) => {
    const handlers = new Map(), notices = [], id = randomUUID();
    let provider;
    register({ registerProvider(name, value) { provider = value; }, on(name, handler) { handlers.set(name, handler); } });
    handlers.get("session_start")({}, { cwd: CUSTOM, hasUI, ui: { notify: (...args) => notices.push(args) }, sessionManager: {
      getSessionId: () => id, getSessionFile: () => undefined, getLeafId: () => "leaf",
    } });
    t.after(() => handlers.get("session_shutdown")());
    const options = require(stub).options.at(-1);
    assert.equal(options.piSessionId(), id);
    assert.equal(options.save({ sessionId: "native-session" }), undefined);
    return { id, provider, notices };
  };
  const a = registerSession(true), b = registerSession(true), headless = registerSession(false);
  const zero = { toolResultsTruncated: 0, toolImagesOmitted: 0 };
  const plural = { toolResultsTruncated: 2, toolImagesOmitted: 4 };
  assert.equal(b.provider.streamSimple(model, {}, { sessionId: a.id, losses: plural }), a.id);
  assert.deepEqual(a.notices, [["Antigravity imported this history with 2 tool results shortened, 4 images omitted.", "warning"]]);
  assert.deepEqual(b.notices, []);
  const singular = Object.fromEntries(Object.keys(zero).map(key => [key, 1]));
  assert.equal(a.provider.streamSimple(model, {}, { sessionId: b.id, losses: singular }), b.id);
  assert.deepEqual(b.notices, [["Antigravity imported this history with 1 tool result shortened, 1 image omitted.", "warning"]]);
  a.provider.streamSimple(model, {}, { sessionId: a.id, losses: zero });
  a.provider.streamSimple(model, {}, { sessionId: headless.id, losses: singular });
  assert.equal(a.notices.length, 1);
  assert.equal(b.notices.length, 1);
  assert.deepEqual(headless.notices, []);
});

const root = mkdtempSync(join(tmpdir(), "pi-acp-transport-"));
const executable = join(root, "mock-agy");
const originalGeminiHome = process.env.GEMINI_HOME;
process.env.GEMINI_HOME = join(root, "gemini");
mkdirSync(process.env.GEMINI_HOME);
after(() => {
  if (originalGeminiHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = originalGeminiHome;
  rmSync(root, { recursive: true, force: true });
});
writeFileSync(executable, `#!${process.execPath}
const readline = require('node:readline');
if (process.env.ACP_FIXTURE_STOP_FILE) {
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => setTimeout(() => {
    require('node:fs').writeFileSync(process.env.ACP_FIXTURE_STOP_FILE, 'stopped'); process.exit(0);
  }, 100));
}
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...message})+'\\n');
let permissionPrompt, permissionReplies = [];
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method) {
    if (String(m.id).startsWith('permission-')) {
      permissionReplies.push(m.result.outcome);
      if (permissionReplies.length === 6) send({id:permissionPrompt,result:permissionReplies});
    } else send({method:'session/update',params:{reply:m}});
    return;
  }
  if (m.method === 'initialize') {
    send({method:'session/update',params:{started:true}});
    if (process.env.ACP_FIXTURE_MODE === 'silent') return;
    if (process.env.ACP_FIXTURE_MODE === 'exit') process.exit(7);
    send({id:m.id,result:{protocolVersion:1,received:m.params,argv:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME,xdgConfig:process.env.XDG_CONFIG_HOME,xdgData:process.env.XDG_DATA_HOME}});
  } else if (m.method === 'session/new') {
    const session = JSON.parse(process.env.ACP_FIXTURE_SESSION || '{}');
    send(session.error ? {id:m.id,error:{code:session.errorCode ?? -32000,message:'secret-upstream'}} : {id:m.id,result:session});
  } else if (m.method === 'activity') {
    send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'still working'}}}});
    send({id:m.id,result:{ok:true}});
  } else if (m.method === 'session/prompt') {
    if (m.params.wait) { send({method:'session/update',params:{sessionId:m.params.sessionId,waiting:true}}); return; }
    permissionPrompt = m.id;
    const cases = [
      {name:'mcp_pi_echo'},
      {name:'run_command'},
      {name:'mcp_pi_missing'},
      {name:'mcp_pi-bridge_pi_echo'},
      {name:'mcp_pi_echo',sessionId:'unrelated'},
      {title:'Run mcp_pi_echo'},
    ];
    cases.forEach(({sessionId = m.params.sessionId, ...toolCall}, i) => send({id:'permission-'+i,method:'session/request_permission',params:{sessionId,toolCall,options:[{optionId:'always',kind:'allow_always'},{optionId:'once',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}}));
  } else if (m.method === 'exercise') {
    for (const [i, method] of ['session/request_permission','fs/read_text_file','fs/write_text_file','terminal/create','terminal/output','terminal/kill','terminal/release','terminal/wait_for_exit'].entries()) send({id:'agent-'+i,method,params:{options:[{optionId:'yes',kind:'allow_always'}]}});
    send({id:m.id,result:{ok:true}});
  } else if (m.method === 'crash') { process.stderr.write('secret-stderr'); process.exit(9); }
  else if (m.method === 'invalid') process.stdout.write('not-json\\n');
  else if (m.method === 'error') send({id:m.id,error:{code:m.params.code ?? -32000,message:'secret-upstream'}});
  else if (m.method === 'hang') send({method:'session/update',params:{hanging:true}});
  else send({id:m.id,result:m.params});
});
`, { mode: 0o700 });
let createAcpConnection, Client, StreamableHTTPClientTransport;
before(async () => {
  ({ createAcpConnection } = await jiti.import(join(CUSTOM, "antigravity/transport.ts")));
  ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
  ({ StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
});

function fixture(t, mode, session) {
  const saved = [process.env.AGY_ACP_BIN, process.env.ACP_FIXTURE_MODE, process.env.ACP_FIXTURE_SESSION];
  process.env.AGY_ACP_BIN = executable;
  if (mode) process.env.ACP_FIXTURE_MODE = mode; else delete process.env.ACP_FIXTURE_MODE;
  if (session) process.env.ACP_FIXTURE_SESSION = JSON.stringify(session); else delete process.env.ACP_FIXTURE_SESSION;
  t.after(() => {
    for (const [key, value] of [["AGY_ACP_BIN", saved[0]], ["ACP_FIXTURE_MODE", saved[1]], ["ACP_FIXTURE_SESSION", saved[2]]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}
async function waitForTransport(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected fixture event");
}
const tools = [{ name: "echo", description: "Echo a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }];

test("initializes the verified CLI launch and serves authenticated, namespaced Pi tools", async (t) => {
  fixture(t);
  const calls = [];
  const connection = await createAcpConnection(root, {
    update() {}, tool: async (name, args) => { calls.push({ name, args }); return { content: [{ type: "text", text: args.value }], isError: false }; },
  }, tools);
  t.after(() => connection.close());
  assert.deepEqual(connection.initialized.received.clientCapabilities, {});
  assert.deepEqual(connection.initialized.argv, ["acp", "--process-per-session", "--disable-telemetry", "--include-default-customizations=false", "--agent", "pi"]);
  assert.equal(connection.initialized.cwd, realpathSync(root));
  assert.equal(connection.initialized.home, process.env.HOME);
  assert.equal(connection.initialized.xdgConfig, process.env.XDG_CONFIG_HOME);
  assert.equal(connection.initialized.xdgData, process.env.XDG_DATA_HOME);
  assert.equal(connection.mcpServer.type, "http");
  assert.equal(connection.mcpServer.name, "pi");
  assert.equal(new URL(connection.mcpServer.url).hostname, "127.0.0.1");
  assert.equal((await fetch(connection.mcpServer.url)).status, 401);
  const headers = Object.fromEntries(connection.mcpServer.headers.map(({ name, value }) => [name, value]));
  const client = new Client({ name: "fixture", version: "1" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.mcpServer.url), { requestInit: { headers } }));
  assert.deepEqual((await client.listTools()).tools, [{ name: "echo", description: "Echo a value", inputSchema: tools[0].parameters }]);
  assert.deepEqual(await client.callTool({ name: "echo", arguments: { value: "hello" } }), { content: [{ type: "text", text: "hello" }], isError: false });
  assert.deepEqual(calls, [{ name: "echo", args: { value: "hello" } }]);
  const invalid = await client.callTool({ name: "missing", arguments: {} }).catch((e) => e);
  assert.match(String(invalid), /Unknown Pi tool/);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(connection.mcpServer.url, { method: "POST", headers: { ...headers, Host: "attacker.example", Accept: "application/json, text/event-stream", "Content-Type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }));
  });
  assert.equal(status, 403);
  connection.close();
  await assert.rejects(connection.request("echo", {}), /closed/);
  await assert.rejects(fetch(connection.mcpServer.url));
});

test("installs the Pi agent once and refuses a different existing definition without overwriting it", async (t) => {
  fixture(t);
  const geminiDir = mkdtempSync(join(root, "agent-install-"));
  const path = join(geminiDir, "config/agents/pi/agent.md");
  const callbacks = { update() {}, tool: async () => ({ content: [] }) };
  const first = await createAcpConnection(root, callbacks, [], { GEMINI_HOME: geminiDir });
  await first.close();
  assert.equal(readFileSync(path, "utf8"), readFileSync(join(CUSTOM, "antigravity/agent.md"), "utf8"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const before = statSync(path, { bigint: true });
  const reused = await createAcpConnection(root, callbacks, [], { GEMINI_HOME: geminiDir });
  await reused.close();
  assert.equal(statSync(path, { bigint: true }).mtimeNs, before.mtimeNs);
  writeFileSync(path, "user-owned agent definition");
  await assert.rejects(createAcpConnection(root, callbacks, [], { GEMINI_HOME: geminiDir }), /Existing Antigravity agent conflicts/);
  assert.equal(readFileSync(path, "utf8"), "user-owned agent definition");
});

test("default-profile creation uses an awaited writer and resume uses MCP workers without app-data overrides", async (t) => {
  fixture(t);
  const marker = join(root, "writer-stopped");
  const profile = { geminiDir: root, historyTarget: true };
  const connection = await createAcpConnection(root, { update() {}, tool: async () => { throw new Error("Unexpected tool"); } }, [],
    { ACP_FIXTURE_STOP_FILE: marker }, undefined, profile);
  assert.deepEqual(connection.initialized.argv, ["acp", "--gemini-dir", root,
    "--disable-telemetry", "--include-default-customizations=false", "--agent", "pi"]);
  assert.equal(readFileSync(join(root, "config/agents/pi/agent.md"), "utf8"), readFileSync(join(CUSTOM, "antigravity/agent.md"), "utf8"));
  const stopped = connection.close();
  assert.equal(connection.closed, true);
  assert.ok(stopped instanceof Promise);
  await stopped;
  assert.equal(readFileSync(marker, "utf8"), "stopped");
  await connection.close();
  const resumed = await createAcpConnection(root, { update() {}, tool: async () => { throw new Error("Unexpected tool"); } }, [],
    undefined, undefined, { geminiDir: root });
  assert.deepEqual(resumed.initialized.argv, ["acp", "--process-per-session", "--gemini-dir", root,
    "--disable-telemetry", "--include-default-customizations=false", "--agent", "pi"]);
  await resumed.close();
});

test("forwards updates, cancels permissions and denies all filesystem and terminal RPCs", async (t) => {
  fixture(t);
  const updates = [];
  const connection = await createAcpConnection(root, { update: (params) => updates.push(params), tool: async () => { throw new Error("Unexpected tool"); } });
  t.after(() => connection.close());
  assert.deepEqual(await connection.request("exercise", {}), { ok: true });
  await waitForTransport(() => updates.filter((event) => event.reply).length === 8);
  const replies = updates.filter((event) => event.reply).map((event) => event.reply);
  assert.deepEqual(replies[0], { jsonrpc: "2.0", id: "agent-0", result: { outcome: { outcome: "cancelled" } } });
  for (const reply of replies.slice(1)) assert.equal(reply.error.code, -32601);
  await assert.rejects(connection.request("error", {}), { code: -32000, message: "Antigravity is not signed in. Run agy to sign in." });
  await assert.rejects(connection.request("error", { code: -32603 }), { code: -32603, message: "ACP request failed (-32603)" });
  assert.deepEqual(await connection.request("echo", { still: "alive" }), { still: "alive" });
});

test("only registered Pi MCP tools in the active prompt receive one-time permission", async (t) => {
  fixture(t);
  const connection = await createAcpConnection(root, { update() {}, tool: async () => ({ content: [] }) }, tools);
  t.after(() => connection.close());
  const outcomes = await connection.request("session/prompt", { sessionId: "fixture-session", prompt: [{ type: "text", text: "hello" }] });
  assert.deepEqual(outcomes, [
    { outcome: "selected", optionId: "once" },
    ...Array.from({ length: 5 }, () => ({ outcome: "cancelled" })),
  ]);
});

test("process exit and malformed output reject all pending requests and clean up MCP", async (t) => {
  fixture(t);
  for (const method of ["crash", "invalid"]) {
    const connection = await createAcpConnection(root, { update() {}, tool: async () => ({ content: [] }) });
    t.after(() => connection.close());
    const pending = connection.request("hang", {});
    const failed = connection.request(method, {});
    await Promise.all([assert.rejects(pending, /ACP/), assert.rejects(failed, /ACP/)]);
    await assert.rejects(connection.request("echo", {}), /closed/);
    await assert.rejects(fetch(connection.mcpServer.url));
  }
});

test("startup failure and absent executable reject without exposing stderr", async (t) => {
  fixture(t, "exit");
  const callbacks = { update() {}, tool: async () => ({ content: [] }) };
  await assert.rejects(createAcpConnection(root, callbacks), /ACP/);
  process.env.AGY_ACP_BIN = join(root, "missing-executable");
  await assert.rejects(createAcpConnection(root, callbacks), /Unable to start agy ACP/);
});

test("provider environment overrides reach the child and cancellation interrupts startup", { timeout: 3000 }, async (t) => {
  fixture(t);
  const controller = new AbortController();
  let started = false;
  const pending = createAcpConnection(root, {
    update(params) { if (params.started) { started = true; controller.abort(); } },
    tool: async () => ({ content: [] }),
  }, [], { ACP_FIXTURE_MODE: "silent" }, controller.signal);
  await assert.rejects(pending, /startup aborted/);
  assert.equal(started, true);
  assert.equal(process.env.ACP_FIXTURE_MODE, undefined);
});

test("prompt timeout is an idle watchdog that refreshes on matching session activity", async (t) => {
  fixture(t);
  const connection = await createAcpConnection(root, { update() {}, tool: async () => ({ content: [] }) });
  t.after(() => connection.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(connection.request("session/prompt", { sessionId: "idle", wait: true }, { timeoutMs: 100 }),
    { name: "AbortError", message: "ACP request timed out: session/prompt" });
  await connection.request("echo", {});
  t.mock.timers.tick(80);
  await connection.request("activity", { sessionId: "idle" });
  t.mock.timers.tick(80);
  assert.deepEqual(await connection.request("echo", { alive: true }), { alive: true });
  await connection.request("activity", { sessionId: "other" });
  t.mock.timers.tick(20);
  await assert.rejects(connection.request("echo", {}), /closed/);
  await rejected;
  t.mock.timers.tick(2000);
  t.mock.timers.reset();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test("tool execution suspends the watchdog and continuation updates its resumed interval", async (t) => {
  fixture(t);
  let release, started;
  const toolStarted = new Promise((resolve) => { started = resolve; });
  const connection = await createAcpConnection(root, {
    update() {}, tool: async () => { started(); return new Promise((resolve) => { release = resolve; }); },
  }, tools);
  t.after(() => connection.close());
  const client = new Client({ name: "fixture", version: "1" });
  t.after(() => client.close());
  const headers = Object.fromEntries(connection.mcpServer.headers.map(({ name, value }) => [name, value]));
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.mcpServer.url), { requestInit: { headers } }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(connection.request("session/prompt", { sessionId: "parked", wait: true }, { timeoutMs: 100 }), /timed out: session\/prompt/);
  await connection.request("echo", {});
  const toolResult = client.callTool({ name: "echo", arguments: { value: "hello" } }, undefined, { timeout: 2_000_000 });
  await toolStarted;
  t.mock.timers.tick(600_001);
  assert.deepEqual(await connection.request("echo", { alive: true }), { alive: true });
  connection.setPromptWatchdog("parked", { timeoutMs: 50 });
  t.mock.timers.tick(600_001);
  assert.deepEqual(await connection.request("echo", {}), {});
  release({ content: [] });
  await toolResult;
  t.mock.timers.tick(40);
  assert.deepEqual(await connection.request("echo", {}), {});
  t.mock.timers.tick(10);
  await rejected;
  t.mock.timers.tick(2000);
  t.mock.timers.reset();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test("zero disables the prompt watchdog but leaves ordinary RPC deadlines independent", async (t) => {
  fixture(t);
  const connection = await createAcpConnection(root, { update() {}, tool: async () => ({ content: [] }) });
  t.after(() => connection.close());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const prompt = assert.rejects(connection.request("session/prompt", { sessionId: "disabled", wait: true }, { timeoutMs: 0 }), /timed out: hang/);
  await connection.request("echo", {});
  t.mock.timers.tick(1_200_000);
  assert.deepEqual(await connection.request("echo", {}), {});
  const rpc = assert.rejects(connection.request("hang", {}), /timed out: hang/);
  t.mock.timers.tick(29_999);
  assert.deepEqual(await connection.request("echo", {}), {});
  t.mock.timers.tick(1);
  await Promise.all([rpc, prompt]);
  t.mock.timers.tick(2000);
  t.mock.timers.reset();
  await new Promise((resolve) => setTimeout(resolve, 100));
});

test("abort closes a pending prompt and a pre-aborted request is never sent", async (t) => {
  fixture(t);
  const connection = await createAcpConnection(root, { update() {}, tool: async () => ({ content: [] }) });
  t.after(() => connection.close());
  await assert.rejects(connection.request("echo", {}, { signal: AbortSignal.abort() }), /aborted/);
  assert.deepEqual(await connection.request("echo", {}), {});
  const controller = new AbortController();
  const prompt = assert.rejects(connection.request("session/prompt", { sessionId: "abort", wait: true }, { timeoutMs: 0, signal: controller.signal }), /aborted/);
  controller.abort();
  await prompt;
  connection.setPromptWatchdog("abort", { timeoutMs: 1 });
  await assert.rejects(connection.request("echo", {}), /closed/);
});

test("startup has a bounded initialization deadline", async (t) => {
  fixture(t, "silent");
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = createAcpConnection(root, { update: started, tool: async () => ({ content: [] }) });
  const rejected = assert.rejects(pending, /timed out: initialize/);
  await ready;
  t.mock.timers.tick(30_000);
  await rejected;
  t.mock.timers.reset();
});

function provider() {
  let config;
  registerAntigravity({ registerProvider(id, value) { if (id === "antigravity") config = value; }, on() {} });
  return config;
}

const context = (extra = {}) => ({ allowNetwork: false, signal: new AbortController().signal, publish: async () => true, ...extra });

test("offline startup restores the cached catalog without starting agy", async (t) => {
  fixture(t, undefined, { error: true });
  const config = provider();
  await assert.rejects(config.refreshModels(context({ allowNetwork: true, signal: AbortSignal.abort() })), /abort/i);
  assert.deepEqual(config.models, []);
  const cached = { id: "gemini-4-argon", name: "Cached", provider: "antigravity", api: "antigravity" };
  const rejected = ["default", "claude-opus-5-5", "gpt-oss-120b-medium", "Gemini-test", "gemini-", "gemini-unknown"];
  const restored = await config.refreshModels(context({ stored: { checkedAt: 0, models: [cached,
    ...rejected.map(id => ({ ...cached, id })), { ...cached, id: "gemini-wrong-provider", provider: "other" },
  ] } }));
  assert.deepEqual(restored.map(model => [model.id, model.name]), [["gemini-4-argon", "Gemini 4 Argon"]]);
  const google = ai.getModels("google").find(model => model.id === cached.id);
  assert.equal(restored[0].contextWindow, google.contextWindow);
  assert.equal(restored[0].maxTokens, google.maxTokens);
  assert.equal(restored[0].reasoning, false);
  assert.ok(restored.every(model => model.compat?.supportsMidConvoSystemMessages === false));
  assert.deepEqual(await config.refreshModels(context()), []);
});

test("cached Gemini models use calibrated native windows and verified ACP thinking levels", async () => {
  const ids = ["gemini-4-neon", "gemini-4-hydrogen", "gemini-4-carbon"];
  const restored = await provider().refreshModels(context({ stored: { models: ids.map(id => ({ id, provider: "antigravity" })) } }));
  for (const entry of restored) {
    const google = ai.getModels("google").find(model => model.id === entry.id);
    assert.equal(entry.name, google.name);
    assert.equal(entry.contextWindow, entry.id === "gemini-4-hydrogen" ? 256000 : 512000);
    assert.equal(entry.maxTokens, google.maxTokens);
    assert.deepEqual(entry.thinkingLevelMap, google.thinkingLevelMap);
    assert.deepEqual(ai.getSupportedThinkingLevels(entry), entry.id === "gemini-4-carbon"
      ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"]);
  }
});

test("refresh discovers grouped model choices, deduplicates IDs and persists metadata only", async (t) => {
  fixture(t, undefined, { sessionId: "discovery", configOptions: [{ id: "model_id", type: "select", category: "model", options: [
    { value: "gemini-4-argon", name: "First" }, { group: "Other", options: [{ value: "gemini-two", name: "Second" }, { value: "gemini-4-argon", name: "Duplicate" }] },
    ...["default", "claude-opus-5-5", "gpt-oss-120b-medium", "gemini-"].map(value => ({ value, name: value })),
  ] }], models: { availableModels: [{ modelId: "legacy", name: "Ignored" }] } });
  const publications = [];
  const models = await provider().refreshModels(context({ allowNetwork: true, publish: async value => { publications.push(value); return true; } }));
  assert.deepEqual(models.map(model => [model.id, model.name]), [["gemini-4-argon", "Gemini 4 Argon"]]);
  assert.ok(models.every(model => model.compat?.supportsMidConvoSystemMessages === false));
  assert.equal(publications.length, 1);
  assert.deepEqual(publications[0].persist.models.map(model => model.id), ["gemini-4-argon"]);
  assert.ok(publications[0].persist.models.every(model => model.provider === "antigravity" && model.api === "antigravity"));
  assert.ok(!JSON.stringify(publications).includes("discovery"));
});

test("refresh supports legacy availableModels and leaves cache untouched on authentication or empty catalog errors", async (t) => {
  fixture(t, undefined, { sessionId: "legacy", models: { availableModels: [{ modelId: "gemini-4-carbon", name: "Legacy" }, { modelId: "gemini-legacy", name: "Unknown" }, { modelId: "claude-opus-5-5", name: "Excluded" }] } });
  assert.deepEqual((await provider().refreshModels(context({ allowNetwork: true }))).map(model => model.id), ["gemini-4-carbon"]);
  for (const session of [{ error: true }, { sessionId: "empty" }, { models: { availableModels: [{ modelId: "claude-opus-5-5" }] } }]) {
    fixture(t, undefined, session);
    let published = false;
    await assert.rejects(provider().refreshModels(context({ allowNetwork: true, publish: async () => { published = true; return true; } })), session.error ? /Antigravity is not signed in\. Run agy to sign in\./ : /did not advertise any models/);
    assert.equal(published, false);
  }
});

test("native runtime refresh discovers real IDs and registers only antigravity", async (t) => {
  fixture(t, undefined, { configOptions: [{ id: "model", type: "select", options: [{ value: "gemini-4-neon", name: "Different display label" }, { value: "gemini-unknown", name: "Unknown" }] }] });
  const { ModelRuntime } = await jiti.import(join(PI_PACKAGE, "dist/core/model-runtime.js"));
  const { InMemoryCredentialStore } = await jiti.import(join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/auth/credential-store.js"));
  const { InMemoryModelsStore } = await jiti.import(join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/models-store.js"));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const handlers = new Map();
  registerAntigravity({ registerProvider: (id, config) => runtime.registerProvider(id, config), on: (event, handler) => handlers.set(event, handler) });
  handlers.get("session_start")({ reason: "reload" }, { cwd: process.cwd(), sessionManager: { getSessionId: () => "catalog-reload-test" }, ui: { notify() {} } });
  t.after(() => handlers.get("session_shutdown")());
  await runtime.refresh({ allowNetwork: false });
  assert.deepEqual(runtime.getModels("antigravity").map(model => model.id), []);
  const result = await runtime.refresh({ providers: ["antigravity"], allowNetwork: true });
  assert.equal(result.errors.size, 0);
  const model = runtime.getModel("antigravity", "gemini-4-neon");
  assert.equal(model.name, "Gemini 4 Neon");
  assert.equal(model.provider, "antigravity");
  assert.deepEqual(runtime.getModels("antigravity").map(model => model.id), ["gemini-4-neon"]);
  assert.ok(runtime.getAvailableSnapshot().some(model => model.provider === "antigravity" && model.id === "gemini-4-neon"));
});


test("native refresh failures warn using structured authentication codes without upstream secrets", async (t) => {
  for (const [code, expectedCode] of [[-32000, -32000], [-32603, -32603], ["-32000", "-32000"],
    ["secret-upstream", undefined], [{ detail: "secret-upstream" }, undefined]]) {
    fixture(t, undefined, { error: true, errorCode: code });
    const handlers = new Map(), notices = [];
    let config;
    registerAntigravity({ registerProvider(id, value) { if (id === "antigravity") config = value; }, on(event, handler) { handlers.set(event, handler); } });
    handlers.get("session_start")({}, { cwd: process.cwd(), sessionManager: { getSessionId: () => "catalog-error-test" }, ui: { notify: (...args) => notices.push(args) } });
    t.after(() => handlers.get("session_shutdown")());
    const message = code === -32000 ? "Antigravity is not signed in. Run agy to sign in."
      : expectedCode === undefined ? "ACP request failed" : `ACP request failed (${expectedCode})`;
    await assert.rejects(config.refreshModels(context({ allowNetwork: true })), { code: expectedCode, message });
    assert.deepEqual(notices, [[`Could not refresh Antigravity models (${code === -32000 ? "agy is not signed in" : message}).`, "warning"]]);
    assert.ok(!notices[0][0].includes("secret-upstream"));
  }
});

