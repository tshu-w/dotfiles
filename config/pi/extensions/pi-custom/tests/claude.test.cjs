const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const { execFileSync } = require("node:child_process");
const { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, utimesSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
// Keep the once-per-process orphan cleanup away from the real state directory.
globalThis[Symbol.for("pi-custom:claude-orphans-removed")] = true;

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const CUSTOM = join(__dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "pi-claude-test-"));
process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));
const jiti = createJiti(__filename, {
  alias: {
    "@earendil-works/pi-ai/compat": join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-ai": join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-coding-agent": join(PI_PACKAGE, "dist/index.js"),
  },
});
let createClaudeBridge, ai, sessions, Client, InMemoryTransport, model;
const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const tool = { name: "echo", description: "Echo input", parameters: {
  type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "number" } }] } }, required: ["value"],
} };
const result = (id, text) => ({ role: "toolResult", toolCallId: id, toolName: "echo", content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
const aborted = (id) => ({ ...result(id, "Operation aborted"), isError: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  throw new Error("Expected asynchronous state was not reached");
}

before(async () => {
  ({ createClaudeBridge } = await jiti.import(join(CUSTOM, "claude/bridge.ts")));
  ai = await jiti.import("@earendil-works/pi-ai");
  sessions = await import("cc-session-io");
  ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
  ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));
  model = { ...ai.getModel("anthropic", "claude-haiku-4-5"), provider: "claude-code", api: "claude-code" };
});

function harness(t, accountInfo = async () => ({ apiProvider: "firstParty", subscriptionType: "max" })) {
  const calls = [], saved = [], traces = [];
  let initless = false;
  const query = ({ prompt, options }) => {
    const queue = [];
    let wake, failure, closed = false;
    const session = sessions.createSession({ projectPath: directory, ...options.forkSession && options.sessionId ? { sessionId: options.sessionId } : {} });
    session.addUserMessage("fixture");
    const uuid = session.addAssistantMessage([{ type: "text", text: "fixture" }]);
    session.save();
    const call = {
      options, accountInfo, prompts: [], sessionId: options.forkSession ? session.sessionId : options.resume ?? session.sessionId, uuid,
      get closed() { return closed; },
      emit(message) { queue.push(message); wake?.(); wake = undefined; },
      event(event) { this.emit({ type: "stream_event", parent_tool_use_id: null, event }); },
      close() { closed = true; wake?.(); wake = undefined; },
      fail(error) { failure = error; wake?.(); wake = undefined; },
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          if (!queue.length && !failure) await new Promise((resolve) => { wake = resolve; });
          while (queue.length && !closed) yield queue.shift();
          if (failure) throw failure;
        }
      },
      begin() { this.event({ type: "message_start", message: { id: "msg-test", model: model.id, usage: { input_tokens: 7, cache_read_input_tokens: 2000, cache_creation_input_tokens: 40 } } }); },
      text(text) {
        this.begin();
        this.event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        this.event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
        this.event({ type: "content_block_stop", index: 0 });
        this.event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } });
        this.event({ type: "message_stop" });
      },
      // Claude Code's record of the tool uses, which makes the tool gap a resume point.
      record(ids, uuid = "uuid-tools") { this.emit({ type: "assistant", uuid, message: { content: ids.map((id) => ({ type: "tool_use", id })) } }); },
      tools(ids = ["call-a", "call-b"]) {
        this.begin();
        for (const [index, id] of ids.entries()) {
          this.event({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "mcp__pi__echo", input: {} } });
          this.event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ value: id }) } });
          this.event({ type: "content_block_stop", index });
        }
        this.event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } });
        this.event({ type: "message_stop" });
      },
      finish() {
        this.emit({ type: "assistant", uuid: this.uuid });
        this.emit({ type: "result", subtype: "success", is_error: false, result: "done" });
      },
      async client() {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test", version: "1" });
        await this.options.mcpServers.pi.instance.connect(serverSide);
        await client.connect(clientSide);
        t.after(() => client.close());
        return client;
      },
    };
    calls.push(call);
    if (!initless) call.emit({ type: "system", subtype: "init", session_id: call.sessionId });
    void (async () => { try { for await (const message of prompt) call.prompts.push(message); } catch {} })();
    return call;
  };
  const bridge = createClaudeBridge({ cwd: () => directory, sessionId: () => "pi-main", save: (state) => saved.push(state), clear() {}, forkSources: () => [], query, trace: (message) => traces.push(message) });
  t.after(() => bridge.reset());
  const stream = (messages, options = {}, tools = [tool]) => bridge.streamSimple(model,
    ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools, messages }), { sessionId: "pi-main", ...options });
  return { bridge, calls, saved, traces, stream, query, initless: (value = true) => { initless = value; } };
}

const callTool = (client, id) => client.callTool({ name: "echo", arguments: { value: id }, _meta: { "claudecode/toolUseId": id } });

test("subscription requests strip API keys without changing the parent environment", async (t) => {
  const h = harness(t), original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "parent-key";
  t.after(() => { if (original === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = original; });
  const stream = h.stream([user("hello")], { env: {
    ANTHROPIC_API_KEY: "request-key", CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HTTPS_PROXY: "http://127.0.0.1:7890", CLAUDE_CODE_USE_BEDROCK: "false",
    CLAUDE_CODE_RETRY_WATCHDOG: "1", CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS: "600000", CLAUDE_CODE_EXTRA_BODY: "{}",
  } });
  await until(() => h.calls.length === 1);
  const env = h.calls[0].options.env;
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(process.env.ANTHROPIC_API_KEY, "parent-key");
  assert.equal(env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.deepEqual([env.CLAUDE_CODE_SILENT_TURN_REMINDER, env.CLAUDE_CODE_TOTAL_TOKENS_REMINDER, env.CLAUDE_CODE_ELEGANT_MEADOW, env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH], ["0", "off", "0", "16384"]);
  assert.deepEqual([env.CLAUDE_CODE_RETRY_WATCHDOG, env.CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS, env.CLAUDE_CODE_EXTRA_BODY], [undefined, undefined, undefined]);
  h.calls[0].text("hello"); h.calls[0].finish();
  assert.equal((await stream.result()).stopReason, "stop");
});

test("subscription requests reject auth and backend overrides before launching the SDK", { timeout: 1000 }, async (t) => {
  const h = harness(t);
  for (const env of [
    { ANTHROPIC_AUTH_TOKEN: "secret-value" },
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { ANTHROPIC_CUSTOM_HEADERS: "X-Test: allowed\nAuthorization: Bearer secret-value" },
  ]) {
    const answer = await h.stream([user("blocked")], { env }).result();
    assert.match(answer.errorMessage, /Claude Code billing/);
    assert.doesNotMatch(answer.errorMessage, /secret-value/);
    assert.equal(ai.isRetryableAssistantError(answer), false);
  }
  const answer = await h.stream([user("blocked")], { headers: { "x-api-key": "secret-value" } }).result();
  assert.match(answer.errorMessage, /Claude Code billing/);
  assert.equal(h.calls.length, 0);
});

test("account verification precedes prompts and refuses non-subscription logins", { timeout: 3000 }, async (t) => {
  for (const account of [
    {}, { apiProvider: "gateway", subscriptionType: "max" },
    { apiProvider: "firstParty", subscriptionType: "max", apiKeySource: "apiKeyHelper" },
  ]) {
    const h = harness(t, async () => account);
    const stream = h.stream([user("must not send")]);
    await until(() => h.calls.length === 1);
    await tick();
    assert.equal(h.calls[0].prompts.length, 0);
    const answer = await stream.result();
    assert.match(answer.errorMessage, /subscription login/);
    assert.equal(ai.isRetryableAssistantError(answer), false);
    await until(() => h.calls[0].closed);
  }
  let resolve;
  const h = harness(t, () => new Promise((done) => { resolve = done; }));
  const controller = new AbortController();
  const stream = h.stream([user("cancel before login check")], { signal: controller.signal });
  await until(() => h.calls.length === 1);
  controller.abort();
  assert.equal((await stream.result()).stopReason, "aborted");
  await until(() => h.calls[0].closed);
  resolve({ apiProvider: "firstParty", subscriptionType: "max" });
  await tick();
  assert.equal(h.calls[0].prompts.length, 0);
});

test("streams text, usage and payload edits; resumes and restores unchanged history", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("hello")];
  const first = h.stream(history, { onPayload: (p) => ({ ...p, systemPrompt: "Modified by Pi" }) });
  await until(() => h.calls.length === 1);
  assert.equal(h.calls[0].options.systemPrompt, "Modified by Pi");
  assert.deepEqual(h.calls[0].options.thinking, { type: "disabled" });
  h.calls[0].text("hello back"); h.calls[0].finish();
  const answer = await first.result();
  assert.equal(answer.stopReason, "stop");
  assert.deepEqual(answer.content, [{ type: "text", text: "hello back" }]);
  assert.equal(answer.usage.totalTokens, 2059);
  assert.ok(answer.usage.cost.total > 0);
  assert.equal(answer.responseId, "msg-test");
  await until(() => h.calls[0].closed);
  assert.equal(h.saved.length, 1);
  const events = []; for await (const event of first) events.push(event.type);
  assert.deepEqual(events, ["start", "text_start", "text_delta", "text_end", "done"]);
  h.bridge.reset(); h.bridge.restore(h.saved[0]);
  const second = h.stream([...history, answer, user("again")]);
  await until(() => h.calls.length === 2 && h.calls[1].prompts.length === 1);
  assert.equal(h.calls[1].options.resume, h.saved[0].sessionId);
  assert.equal(h.calls[1].options.resumeSessionAt, h.saved[0].lastUuid);
  assert.deepEqual(h.calls[1].prompts[0].message.content, [{ type: "text", text: "again" }]);
  h.calls[1].text("again back"); h.calls[1].finish();
  assert.equal((await second.result()).stopReason, "stop");
});

test("mid-conversation system patches resume as user text without changing the prompt", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("hello")];
  const patched = { ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: true } };
  const stream = (messages) => h.bridge.streamSimple(patched,
    ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools: [tool], messages }), { sessionId: "pi-main" });
  const first = stream(history);
  await until(() => h.calls.length === 1);
  h.calls[0].text("hello back"); h.calls[0].finish();
  const answer = await first.result();
  const patch = { role: "system", content: "", sections: { memory: "New memory" }, timestamp: Date.now() };
  const second = stream([...history, answer, patch, user("again")]);
  await until(() => h.calls.length === 2 && h.calls[1].prompts.length === 1);
  assert.equal(h.calls[1].options.resume, h.saved[0].sessionId);
  assert.deepEqual(h.calls[1].options.systemPrompt, h.calls[0].options.systemPrompt);
  assert.deepEqual(h.calls[1].prompts[0].message.content, [
    { type: "text", text: "<system-reminder>\nUpdated system prompt section \"memory\":\n\nNew memory\n</system-reminder>" },
    { type: "text", text: "again" },
  ]);
  h.calls[1].text("again back"); h.calls[1].finish();
  assert.equal((await second.result()).stopReason, "stop");
});

test("Claude preset retains current Pi constraints and routes their tool references through MCP", { timeout: 10000 }, async (t) => {
  const { buildSystemPromptState } = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/system-prompt.js")));
  const state = buildSystemPromptState({
    cwd: directory, selectedTools: ["read", "echo"],
    toolSnippets: { read: "Read files", echo: "Echo input" },
    toolGuidelines: { read: ["Use the read tool to inspect fixtures."], echo: ["Use echo to inspect input.", "Use `echo` before echo(value)."] },
    promptGuidelines: ["Keep read-only paths and echo.txt unchanged."],
    appendSystemPrompt: "Require confirmation before publishing.",
    contextFiles: [{ path: "/project/AGENTS.md", content: "Never upload customer data." }],
    skills: [{ name: "audit", description: "Audit changes", filePath: "/skills/audit/SKILL.md", baseDir: "/skills/audit", source: "user", disableModelInvocation: false }],
    sections: { "custom-policy": "Obsolete policy.", obsolete: "REMOVE_ME" },
  });
  const read = { name: "read", description: "Read files", parameters: { type: "object", properties: { path: { type: "string" } } } };
  const messages = [
    { role: "system", ...state, toolsAdded: [tool, read], timestamp: 0 },
    { role: "system", content: "An extension added this later.", sections: {
      "custom-policy": "<custom-policy>Updated policy.</custom-policy>", obsolete: null,
      ssh: "<ssh>Tools execute on the remote host.</ssh>",
    }, timestamp: 1 },
    user("check"),
  ];
  const before = structuredClone(messages), h = harness(t);
  const stream = h.bridge.streamSimple(model, { messages }, { sessionId: "pi-main" });
  await until(() => h.calls.length === 1);
  const q = h.calls[0], prompt = q.options.systemPrompt;
  assert.equal(prompt.preset, "claude_code");
  assert.ok(!prompt.append.includes(state.sections.preamble));
  assert.ok(!prompt.append.includes(state.sections.docs));
  for (const text of [state.sections.addendum, state.sections.project_context, state.sections.cwd,
    "<custom-policy>Updated policy.</custom-policy>", "An extension added this later.", "<ssh>Tools execute on the remote host.</ssh>", "/skills/audit/SKILL.md"]) {
    assert.ok(prompt.append.includes(text), text);
  }
  assert.doesNotMatch(prompt.append, /Obsolete policy|REMOVE_ME/);
  assert.match(prompt.append, /- mcp__pi__echo: Echo input/);
  assert.match(prompt.append, /Use mcp__pi__echo to inspect input/);
  assert.match(prompt.append, /`mcp__pi__echo` before mcp__pi__echo\(value\)/);
  assert.match(prompt.append, /Use the mcp__pi__read tool to inspect fixtures/);
  assert.match(prompt.append, /Keep read-only paths and echo\.txt unchanged/);
  const client = await q.client();
  for (const { name } of (await client.listTools()).tools) assert.ok(prompt.append.includes(`mcp__pi__${name}`));
  assert.deepEqual(messages, before);
  q.text("checked"); q.finish();
  assert.equal((await stream.result()).stopReason, "stop");
});

test("old Pi install paths do not leak the default docs into Claude", { timeout: 10000 }, async (t) => {
  const { buildSystemPromptState } = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/system-prompt.js")));
  const native = buildSystemPromptState({ cwd: directory });
  const staleDocs = native.sections.docs.replace(
    /^(- (?:Main documentation|Additional docs|Examples): )\S+?(?=\/@earendil-works\/pi-coding-agent\/)/gm,
    "$1/previous-pi-install",
  );
  assert.notEqual(staleDocs, native.sections.docs);
  const h = harness(t);
  for (const [i, docs] of [staleDocs, staleDocs.replace("</docs>", "Extra user instructions.\n</docs>")].entries()) {
    const stream = h.bridge.streamSimple(model, { messages: [
      { role: "system", ...native, sections: { ...native.sections, docs }, toolsAdded: [tool], timestamp: 0 }, user("check"),
    ] }, { sessionId: "pi-main" });
    await until(() => h.calls.length === i + 1);
    const prompt = h.calls[i].options.systemPrompt;
    assert.equal(prompt.preset, "claude_code");
    assert.equal(prompt.append.includes(docs), i === 1);
    h.calls[i].text("done"); h.calls[i].finish();
    assert.equal((await stream.result()).stopReason, "stop");
  }
});

// Default Pi sections from a session saved by an older Pi; Anthropic bills prompts carrying this docs guide as a third-party app.
const OLD_PREAMBLE = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
const OLD_DOCS = "<docs>\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: /previous-pi-install/@earendil-works/pi-coding-agent/README.md\n- Additional docs: /previous-pi-install/@earendil-works/pi-coding-agent/docs\n- Examples: /previous-pi-install/@earendil-works/pi-coding-agent/examples (extensions, custom tools, SDK)\n- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory\n- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)\n- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing\n- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)\n</docs>";

test("default Pi docs and identity from older Pi versions never reach Claude", { timeout: 10000 }, async (t) => {
  const { buildSystemPromptState } = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/system-prompt.js")));
  const native = buildSystemPromptState({ cwd: directory });
  const h = harness(t), history = [
    { role: "system", ...native, sections: { ...native.sections, preamble: OLD_PREAMBLE, docs: OLD_DOCS }, toolsAdded: [tool], timestamp: 0 },
    user("hello"),
  ];
  const patched = { ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: true } };
  const stream = (messages) => h.bridge.streamSimple(patched, { messages }, { sessionId: "pi-main" });
  const first = stream(history);
  await until(() => h.calls.length === 1);
  const prompt = h.calls[0].options.systemPrompt.append;
  assert.ok(!prompt.includes("docs/custom-provider.md") && !prompt.includes("inside pi"));
  assert.ok(prompt.includes(native.sections.rules));
  h.calls[0].text("hello back"); h.calls[0].finish();
  const answer = await first.result();
  const patch = { role: "system", content: "", sections: { preamble: native.sections.preamble, docs: null, memory: "New memory" }, timestamp: 0 };
  const second = stream([...history, answer, patch, user("again")]);
  await until(() => h.calls.length === 2 && h.calls[1].prompts.length === 1);
  const sent = JSON.stringify(h.calls[1].prompts[0].message.content);
  assert.ok(sent.includes("New memory") && !sent.includes("docs/custom-provider.md") && !sent.includes("inside pi") && !sent.includes("Removed system prompt section"));
  h.calls[1].text("again back"); h.calls[1].finish();
  assert.equal((await second.result()).stopReason, "stop");
});

test("custom sections survive projection and full prompt overrides remain exact", { timeout: 10000 }, async (t) => {
  const { buildSystemPromptState } = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/system-prompt.js")));
  const native = buildSystemPromptState({ cwd: directory });
  const state = buildSystemPromptState({
    cwd: directory, customPrompt: "User-defined identity. Use echo for approvals.",
    appendSystemPrompt: "Keep the customer's exact wording.",
    sections: { docs: "Consult /project/manual.md before changing the API.", "other-extension": "Preserve this new extension." },
  });
  const withDocsAddition = { ...native, sections: {
    ...native.sections, docs: native.sections.docs.replace("</docs>", "Extra user instructions.\n</docs>"),
  } };
  const forced = buildSystemPromptState({ cwd: directory, forceSystemPrompt: "<docs>Use echo exactly as written.</docs>" });
  const explicitDefault = buildSystemPromptState({ cwd: directory, customPrompt: native.sections.preamble });
  const extendedDefault = buildSystemPromptState({ cwd: directory, customPrompt: `${native.sections.preamble}\nKeep the customer's tone.` });
  const appendedDefault = buildSystemPromptState({ cwd: directory, customPrompt: `${native.sections.preamble} Always answer in Chinese.` });
  const cases = [
    { state, retained: Object.values(state.sections) },
    // Pi's default identity is dropped on its own, also beside a custom docs section.
    { state: explicitDefault, retained: [], stripped: [native.sections.preamble] },
    { state: withDocsAddition, retained: [withDocsAddition.sections.docs], stripped: [native.sections.preamble] },
    { state: extendedDefault, retained: [extendedDefault.sections.preamble] },
    { state: appendedDefault, retained: [appendedDefault.sections.preamble] },
    { state: forced, exact: forced.content },
    { state: native, hook: (p) => { p.systemPrompt = "Exact payload-hook override."; }, exact: "Exact payload-hook override." },
  ];
  const h = harness(t);
  for (const [i, fixture] of cases.entries()) {
    const stream = h.bridge.streamSimple(model, { messages: [
      { role: "system", ...fixture.state, toolsAdded: [tool], timestamp: 0 }, user("check"),
    ] }, { sessionId: "pi-main", onPayload: fixture.hook });
    await until(() => h.calls.length === i + 1);
    const q = h.calls[i];
    if (fixture.exact !== undefined) assert.equal(q.options.systemPrompt, fixture.exact);
    else {
      assert.equal(q.options.systemPrompt.preset, "claude_code");
      for (const text of fixture.retained) assert.ok(q.options.systemPrompt.append.includes(text), text);
      for (const text of fixture.stripped ?? []) assert.ok(!q.options.systemPrompt.append.includes(text), text);
    }
    q.text("done"); q.finish();
    assert.equal((await stream.result()).stopReason, "stop");
  }
});

test("changed extension constraints restart a paused query with the updated prompt", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const messages = [
    { role: "system", content: "", sections: { policy: "<policy>Read-only.</policy>" }, toolsAdded: [tool], timestamp: 0 },
    user("tool"),
  ];
  const first = h.bridge.streamSimple(model, { messages }, { sessionId: "pi-main" });
  await until(() => h.calls.length === 1);
  h.calls[0].tools(["call-a"]);
  const answer = await first.result();
  const next = h.bridge.streamSimple(model, { messages: [...messages, answer, result("call-a", "done"),
    { role: "system", content: "", sections: { policy: "<policy>Require approval.</policy>" }, timestamp: 1 },
  ] }, { sessionId: "pi-main" });
  await until(() => h.calls.length === 2);
  await until(() => h.calls[0].closed);
  assert.match(h.calls[1].options.systemPrompt.append, /Require approval/);
  assert.doesNotMatch(h.calls[1].options.systemPrompt.append, /Read-only/);
  h.calls[1].text("awaiting approval"); h.calls[1].finish();
  assert.equal((await next.result()).stopReason, "stop");
});

test("Pi executes parallel tools; MCP pairs out of order and steering is written first", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("use tools")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  const q = h.calls[0], client = await q.client();
  assert.deepEqual((await client.listTools()).tools[0].inputSchema, tool.parameters);
  q.tools();
  const answer = await first.result();
  assert.equal(answer.stopReason, "toolUse");
  assert.deepEqual(answer.content.map((b) => b.arguments), [{ value: "call-a" }, { value: "call-b" }]);
  let acknowledgedAtResolution = false;
  const pendingB = callTool(client, "call-b").then((r) => {
    acknowledgedAtResolution = q.prompts.some((m) => m.priority === "next"); return r;
  });
  const image = { type: "image", data: "YQ==", mimeType: "image/png" };
  const resultB = result("call-b", "second"); resultB.content.push(image); resultB.isError = true;
  const second = h.stream([...history, answer, result("call-a", "first"), user("steer now"), resultB]);
  const receivedB = await pendingB;
  assert.equal(acknowledgedAtResolution, true);
  assert.equal(receivedB.isError, true);
  assert.deepEqual(receivedB.content, resultB.content);
  assert.equal((await callTool(client, "call-a")).content[0].text, "first");
  q.emit({ type: "assistant", uuid: "late-tool-echo", message: { content: [{ type: "tool_use", id: "call-a" }] } });
  q.text("finished"); q.finish();
  assert.deepEqual((await second.result()).content, [{ type: "text", text: "finished" }]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.saved.length, 1);
});

test("an aborted response keeps the resume point and the next turn resumes without it", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("hello")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  h.calls[0].text("hello back"); h.calls[0].finish();
  const answer = await first.result(), state = h.saved[0], controller = new AbortController();
  const second = h.stream([...history, answer, user("long task")], { signal: controller.signal });
  await until(() => h.calls.length === 2 && h.calls[1].prompts.length === 1);
  h.calls[1].begin();
  controller.abort();
  const aborted = await second.result();
  assert.equal(aborted.stopReason, "aborted");
  const third = h.stream([...history, answer, user("long task"), aborted, user("shorter")]);
  await until(() => h.calls.length === 3 && h.calls[2].prompts.length === 1);
  assert.equal(h.calls[2].options.resume, state.sessionId);
  assert.equal(h.calls[2].options.resumeSessionAt, state.lastUuid);
  assert.deepEqual(h.calls[2].prompts[0].message.content, [{ type: "text", text: "long task" }, { type: "text", text: "shorter" }]);
  h.calls[2].text("done"); h.calls[2].finish();
  assert.equal((await third.result()).stopReason, "stop");
});

test("abort during the tool gap releases MCP and resumes at Claude Code's interrupted result", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("tool")], controller = new AbortController();
  const first = h.stream(history, { signal: controller.signal });
  await until(() => h.calls.length === 1);
  const q = h.calls[0], client = await q.client();
  q.tools(["call-a"]); q.record(["call-a"]); const answer = await first.result();
  const pending = callTool(client, "call-a");
  // Claude Code answers the tool use itself when its query is closed.
  await until(() => h.saved.length === 1);
  appendFileSync(sessions.getSessionPath(q.sessionId, directory), JSON.stringify({ type: "user", uuid: "uuid-interrupted",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "The tool call was interrupted." }] } }) + "\n");
  await tick(); controller.abort();
  assert.equal((await pending).isError, true);
  await until(() => q.closed);
  assert.equal(answer.stopReason, "toolUse");
  await until(() => h.saved.at(-1).answered);
  const retry = h.stream([...history, answer, aborted("call-a"), user("next")]);
  await until(() => h.calls.length === 2 && h.calls[1].prompts.length === 1);
  assert.equal(h.calls[1].options.resume, q.sessionId);
  assert.equal(h.calls[1].options.resumeSessionAt, "uuid-interrupted");
  assert.deepEqual(h.calls[1].prompts[0].message.content, [{ type: "text", text: "next" }]);
  h.calls[1].text("recovered"); h.calls[1].finish();
  assert.equal((await retry.result()).stopReason, "stop");
});

test("a finished tool's result reaches Claude Code before an abort ends the batch", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("tools")], controller = new AbortController();
  const first = h.stream(history, { signal: controller.signal });
  await until(() => h.calls.length === 1);
  const q = h.calls[0], client = await q.client();
  q.tools(["call-a", "call-b"]); q.record(["call-a", "call-b"]);
  const answer = await first.result();
  await until(() => h.saved.length === 1);
  const [a, b] = [callTool(client, "call-a"), callTool(client, "call-b")];
  // call-a finishes in Pi while call-b still runs; then the user aborts.
  h.bridge.deliver("call-a", [{ type: "text", text: "real output" }], false);
  assert.deepEqual((await a).content, [{ type: "text", text: "real output" }]);
  appendFileSync(sessions.getSessionPath(q.sessionId, directory), JSON.stringify({ type: "user", uuid: "uuid-interrupted",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "real output" },
      { type: "tool_result", tool_use_id: "call-b", content: "The tool call was interrupted." }] } }) + "\n");
  controller.abort();
  assert.equal((await b).isError, true);
  await until(() => h.saved.at(-1).answered);
  const retry = h.stream([...history, answer, result("call-a", "real output"), aborted("call-b"), user("next")]);
  await until(() => h.calls.length === 2 && h.calls[1].prompts.length === 1);
  assert.equal(h.calls[1].options.resume, q.sessionId);
  assert.equal(h.calls[1].options.resumeSessionAt, "uuid-interrupted");
  assert.deepEqual(h.calls[1].prompts[0].message.content, [{ type: "text", text: "next" }]);
  h.calls[1].text("recovered"); h.calls[1].finish();
  await retry.result();
});

test("the batch's last result waits for Pi's continuation", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("tools")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  const q = h.calls[0], client = await q.client();
  q.tools(["call-a", "call-b"]);
  const answer = await first.result();
  const [a, b] = [callTool(client, "call-a"), callTool(client, "call-b")];
  let lastDelivered = false;
  b.then(() => { lastDelivered = true; });
  // Sequential tools finish one after the other; only the last one is held back.
  h.bridge.deliver("call-a", [{ type: "text", text: "A" }], false);
  assert.deepEqual((await a).content, [{ type: "text", text: "A" }]);
  h.bridge.deliver("call-b", [{ type: "text", text: "B" }], false);
  await tick(); await tick();
  assert.equal(lastDelivered, false);
  const next = h.stream([...history, answer, result("call-a", "A"), result("call-b", "B"), user("steer")]);
  assert.deepEqual((await b).content, [{ type: "text", text: "B" }]);
  assert.equal(q.prompts.at(-1).message.content, "steer");
  assert.equal(h.calls.length, 1);
  q.text("done"); q.finish();
  await next.result();
});

test("a result that differs from what was handed over early rebuilds", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("tools")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  const q = h.calls[0], client = await q.client();
  q.tools(["call-a", "call-b"]);
  const answer = await first.result();
  void callTool(client, "call-a"); void callTool(client, "call-b");
  h.bridge.deliver("call-a", [{ type: "text", text: "early" }], false);
  const next = h.stream([...history, answer, result("call-a", "changed later"), result("call-b", "B")]);
  await until(() => h.calls.length === 2);
  await until(() => q.closed);
  assert.notEqual(h.calls[1].options.resume, q.sessionId);
  h.calls[1].text("rebuilt"); h.calls[1].finish();
  await next.result();
});

test("history rewrites use a new imported session and leave the old session untouched", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const first = h.stream([user("old secret")]);
  await until(() => h.calls.length === 1);
  h.calls[0].text("old answer"); h.calls[0].finish();
  const answer = await first.result(), old = h.saved[0];
  const path = sessions.getSessionPath(old.sessionId, directory), before = readFileSync(path, "utf8");
  const next = h.stream([user("summary only"), answer, user("next")]);
  await until(() => h.calls.length === 2);
  const resume = h.calls[1].options.resume;
  assert.notEqual(resume, old.sessionId);
  const imported = readFileSync(sessions.getSessionPath(resume, directory), "utf8");
  assert.match(imported, /summary only/); assert.doesNotMatch(imported, /old secret/);
  assert.equal(readFileSync(path, "utf8"), before);
  h.calls[1].text("new answer"); h.calls[1].finish();
  assert.equal((await next.result()).stopReason, "stop");
});

test("concurrent independent requests do not overwrite main-session state", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const main = h.stream([user("main")]);
  const auxiliary = h.stream([user("summarize")], { sessionId: "summary" }, []);
  await until(() => h.calls.length === 2);
  assert.equal(h.calls[1].options.persistSession, false);
  h.calls[1].text("summary"); h.calls[1].finish();
  await auxiliary.result(); assert.equal(h.saved.length, 0);
  h.calls[0].text("main answer"); h.calls[0].finish();
  await main.result(); assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].sessionId, h.calls[0].sessionId);
});

test("other requests extending the main history fork its CC session and remove the fork", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("hello")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  h.calls[0].text("hello back"); h.calls[0].finish();
  const answer = await first.result(), state = structuredClone(h.saved[0]);
  const compaction = h.stream([...history, answer, user("summarize")], { sessionId: "compaction" });
  await until(() => h.calls.length === 2 && h.calls[1].prompts.length === 1);
  assert.equal(h.calls[1].options.resume, state.sessionId);
  assert.equal(h.calls[1].options.forkSession, true);
  h.calls[1].text("summary"); h.calls[1].finish();
  assert.equal((await compaction.result()).stopReason, "stop");
  assert.equal(h.saved.length, 1);
  assert.equal(existsSync(sessions.getSessionPath(h.calls[1].sessionId, directory)), false);
  assert.equal(existsSync(sessions.getSessionPath(state.sessionId, directory)), true);
  const warm = h.stream([...history, answer, user("again")], { disableContinuation: true });
  await until(() => h.calls.length === 3);
  assert.equal(h.calls[2].options.forkSession, true);
  h.calls[2].text("warm"); h.calls[2].finish();
  await warm.result();
  assert.equal(h.saved.length, 1);
  const next = h.stream([...history, answer, user("again")]);
  await until(() => h.calls.length === 4);
  assert.equal(h.calls[3].options.resume, state.sessionId);
  assert.equal(h.calls[3].options.forkSession, undefined);
  h.calls[3].text("again back"); h.calls[3].finish();
  await next.result();
});

test("a replay that stops at a tool call is closed with its fork", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("hello")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  h.calls[0].text("hello back"); h.calls[0].finish();
  const answer = await first.result();
  const warm = h.stream([...history, answer, user("again")], { disableContinuation: true });
  await until(() => h.calls.length === 2);
  const q = h.calls[1];
  q.tools(["call-a"]);
  assert.equal((await warm.result()).stopReason, "toolUse");
  await until(() => q.closed);
  await until(() => !existsSync(sessions.getSessionPath(q.sessionId, directory)));
});

test("a side fork whose account check fails removes its fork file", { timeout: 10000 }, async (t) => {
  let checks = 0;
  const h = harness(t, async () => {
    if (checks++) throw new Error("account lookup failed");
    return { apiProvider: "firstParty", subscriptionType: "max" };
  });
  const first = h.stream([user("hello")]);
  await until(() => h.calls.length === 1);
  h.calls[0].text("hello back"); h.calls[0].finish();
  const answer = await first.result();
  const side = await h.stream([user("hello"), answer, user("side")], { sessionId: "side" }).result();
  assert.equal(side.stopReason, "error");
  const fork = h.calls[1].options.sessionId;
  assert.equal(h.calls[1].options.forkSession, true);
  await until(() => !existsSync(sessions.getSessionPath(fork, directory)));
});

test("requests extending the running main query at its tool gap fork there with the tool results", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("tool")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  const q = h.calls[0];
  q.tools(["call-a"]); q.record(["call-a"], "uuid-gap");
  const answer = await first.result();
  await until(() => h.saved.length === 1);
  assert.equal(h.saved[0].lastUuid, "uuid-gap");
  const side = h.stream([...history, answer, result("call-a", "side result"), user("side task")], { sessionId: "side" });
  await until(() => h.calls.length === 2 && h.calls[1].prompts.length === 1);
  assert.equal(q.closed, false);
  assert.equal(h.calls[1].options.resume, q.sessionId);
  assert.equal(h.calls[1].options.resumeSessionAt, "uuid-gap");
  assert.equal(h.calls[1].options.forkSession, true);
  const [toolResult, text] = h.calls[1].prompts[0].message.content;
  assert.equal(toolResult.type, "tool_result"); assert.equal(toolResult.tool_use_id, "call-a");
  assert.deepEqual(text, { type: "text", text: "side task" });
  h.calls[1].text("side done"); h.calls[1].finish();
  assert.equal((await side.result()).stopReason, "stop");
});

test("a tool-gap point restored after a hard exit resumes at Claude Code's interrupted result", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("tool")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  const q = h.calls[0];
  q.tools(["call-a"]); q.record(["call-a"]);
  const answer = await first.result();
  await until(() => h.saved.length === 1);
  assert.deepEqual(h.saved[0].pending, ["call-a"]);
  // Pi was killed: the next process restores the persisted gap point without a reset.
  appendFileSync(sessions.getSessionPath(q.sessionId, directory), JSON.stringify({ type: "user", uuid: "uuid-interrupted",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "The tool call was interrupted." }] } }) + "\n");
  const restarted = createClaudeBridge({ cwd: () => directory, sessionId: () => "pi-main", save() {}, clear() {}, forkSources: () => [], query: h.query });
  t.after(() => restarted.reset());
  restarted.restore(structuredClone(h.saved[0]));
  const next = restarted.streamSimple(model, ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools: [tool],
    messages: [...history, answer, aborted("call-a"), user("next")] }), { sessionId: "pi-main" });
  await until(() => h.calls.length === 2 && h.calls[1].prompts.length === 1);
  assert.equal(h.calls[1].options.resume, q.sessionId);
  assert.equal(h.calls[1].options.resumeSessionAt, "uuid-interrupted");
  assert.deepEqual(h.calls[1].prompts[0].message.content, [{ type: "text", text: "next" }]);
  h.calls[1].text("done"); h.calls[1].finish();
  await next.result();
});

test("a restored tool-gap point with only part of the batch interrupted rebuilds", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("tools")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  const q = h.calls[0];
  q.tools(["call-a", "call-b"]); q.record(["call-a", "call-b"]);
  const answer = await first.result();
  await until(() => h.saved.length === 1);
  appendFileSync(sessions.getSessionPath(q.sessionId, directory), JSON.stringify({ type: "user", uuid: "uuid-partial",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "The tool call was interrupted." }] } }) + "\n");
  const restarted = createClaudeBridge({ cwd: () => directory, sessionId: () => "pi-main", save() {}, clear() {}, forkSources: () => [], query: h.query });
  t.after(() => restarted.reset());
  restarted.restore(structuredClone(h.saved[0]));
  const next = restarted.streamSimple(model, ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools: [tool],
    messages: [...history, answer, result("call-a", "a"), result("call-b", "b"), user("next")] }), { sessionId: "pi-main" });
  await until(() => h.calls.length === 2);
  assert.notEqual(h.calls[1].options.resume, q.sessionId);
  h.calls[1].text("done"); h.calls[1].finish();
  await next.result();
});

test("state of deleted Pi sessions is removed with a Claude Code session no other state uses", async () => {
  const { removeOrphanedStates } = await jiti.import(join(CUSTOM, "claude.ts"));
  const root = mkdtempSync(join(tmpdir(), "pi-claude-orphans-")), sessionsDir = join(root, "sessions"), stateDir = join(root, "state");
  mkdirSync(join(sessionsDir, "--cwd--", "subagents"), { recursive: true }); mkdirSync(stateDir);
  const live = "01a00000-0000-7000-8000-00000000000a";
  writeFileSync(join(sessionsDir, "--cwd--", "subagents", `2026-11-01T00-00-00-000Z_${live}.jsonl`), "");
  const cc = (id) => { const s = sessions.createSession({ projectPath: directory, sessionId: id }); s.addUserMessage("x"); s.save(); return sessions.getSessionPath(id, directory); };
  const [shared, own, recent, parent] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"].map((id) => ({ id, path: cc(id) }));
  const now = Date.now(), old = new Date(now - 120_000);
  const state = (name, piSessionId, sessionId, mtime = old, points = []) => {
    const path = join(stateDir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ piSessionId, sessionId, cwd: directory, size: 0, tip: "", points }));
    utimesSync(path, mtime, mtime);
    return path;
  };
  // The live Session was forked from a deleted one and still holds a point into its CC session.
  const kept = state("live", live, shared.id, old, [{ piSessionId: "01a00000-0000-7000-8000-00000000000e", sessionId: parent.id, cwd: directory, size: 1, tip: "t" }]);
  const forkedFrom = state("parent", "01a00000-0000-7000-8000-00000000000e", parent.id);
  const sharing = state("sharing", "01a00000-0000-7000-8000-00000000000b", shared.id);
  const orphan = state("orphan", "01a00000-0000-7000-8000-00000000000c", own.id);
  const fresh = state("fresh", "01a00000-0000-7000-8000-00000000000d", recent.id, new Date(now));
  removeOrphanedStates(sessionsDir, stateDir, now);
  assert.deepEqual([kept, sharing, orphan, fresh, forkedFrom].map(existsSync), [true, false, false, true, false]);
  assert.deepEqual([shared.path, own.path, recent.path, parent.path].map(existsSync), [true, false, true, true]);
});

test("an empty tool result is imported with Claude Code's no-output placeholder", async () => {
  const { convertPiMessages } = await jiti.import(join(CUSTOM, "claude/convert.ts"));
  const { anthropicMessages } = convertPiMessages([
    { role: "assistant", provider: "claude-code", content: [{ type: "toolCall", id: "call-a", name: "bash", arguments: {} }] },
    { role: "toolResult", toolCallId: "call-a", toolName: "bash", content: [], isError: true },
  ], "claude-sonnet-5-5");
  assert.deepEqual(anthropicMessages[1].content, [{ type: "tool_result", tool_use_id: "call-a", content: "(mcp__pi__bash completed with no output)", is_error: true }]);
});

test("thinking keeps its signature only for the model that signed it", async () => {
  const { convertPiMessages } = await jiti.import(join(CUSTOM, "claude/convert.ts"));
  const answer = (model) => ({ role: "assistant", provider: "claude-code", model, content: [
    { type: "thinking", thinking: "plan", thinkingSignature: "signed" }, { type: "text", text: "done" }] });
  const { anthropicMessages } = convertPiMessages([user("a"), answer("claude-sonnet-5-5"), user("b"), answer("claude-opus-5-5"), user("c")], "claude-opus-5-5");
  assert.deepEqual(anthropicMessages[1].content, [{ type: "text", text: "done" }]);
  assert.deepEqual(anthropicMessages[3].content, [{ type: "thinking", thinking: "plan", signature: "signed" }, { type: "text", text: "done" }]);
});

test("/tree, a restart and a fork resume an earlier point instead of rebuilding", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const turn = async (messages, i) => {
    const stream = h.stream(messages);
    await until(() => h.calls.length === i + 1);
    h.calls[i].text(`answer ${i}`); h.calls[i].finish();
    return stream.result();
  };
  const u1 = user("first"), a1 = await turn([u1], 0);
  const u2 = user("second"), a2 = await turn([u1, a1, u2], 1);
  const first = h.saved.find((state) => state.size === 2), state = structuredClone(h.saved.at(-1));
  assert.equal(state.points.length, 2);
  // /tree back to the first answer, then a new prompt.
  h.bridge.navigate();
  const branch = h.stream([u1, a1, user("other")]);
  await until(() => h.calls.length === 3);
  assert.deepEqual([h.calls[2].options.resume, h.calls[2].options.resumeSessionAt, h.calls[2].options.forkSession], [first.sessionId, first.lastUuid, true]);
  h.calls[2].text("branch"); h.calls[2].finish(); await branch.result();
  // A restarted Pi and a forked Session find the points in the state files.
  for (const [i, restored] of [[3, (b) => b.restore(state)], [4, (b) => b.restore(undefined, state.points)]]) {
    const other = createClaudeBridge({ cwd: () => directory, sessionId: () => "pi-main", save() {}, clear() {}, forkSources: () => [], query: h.query });
    t.after(() => other.reset());
    restored(other);
    const next = other.streamSimple(model, ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools: [tool], messages: [u1, a1, user("again")] }), { sessionId: "pi-main" });
    await until(() => h.calls.length === i + 1);
    assert.deepEqual([h.calls[i].options.resumeSessionAt, h.calls[i].options.forkSession], [first.lastUuid, true]);
    h.calls[i].text("again"); h.calls[i].finish(); await next.result();
  }
});

test("a history changed after a resume point keeps Claude Code's records up to it", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const turn = async (messages, i) => {
    const stream = h.stream(messages);
    await until(() => h.calls.length === i + 1);
    h.calls[i].text(`answer ${i}`); h.calls[i].finish();
    return stream.result();
  };
  const u1 = user("first"), a1 = await turn([u1], 0);
  const u2 = user("second"); await turn([u1, a1, u2], 1);
  const first = h.saved.find((state) => state.size === 2);
  // The second answer was edited: no point continues, but the first one is still a prefix.
  const edited = { ...a1, content: [{ type: "text", text: "edited answer" }] };
  const next = h.stream([u1, a1, u2, edited, user("third")]);
  await until(() => h.calls.length === 3 && h.calls[2].prompts.length === 1);
  const options = h.calls[2].options;
  assert.notEqual(options.resume, first.sessionId);
  assert.equal(options.resumeSessionAt, undefined);
  assert.equal(options.forkSession, undefined);
  const records = readFileSync(sessions.getSessionPath(options.resume, directory), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const at = records.findIndex((r) => r.uuid === first.lastUuid);
  assert.ok(at >= 0, "the kept prefix ends at the point's record");
  assert.deepEqual(records.slice(at + 1).map((r) => r.message?.content).filter(Boolean).map((c) => JSON.stringify(c)).join(" ").match(/second|edited answer/g), ["second", "edited answer"]);
  assert.equal(records[at + 1].parentUuid, first.lastUuid);
  assert.ok(records.every((r) => !r.sessionId || r.sessionId === options.resume));
  assert.deepEqual(h.calls[2].prompts[0].message.content, [{ type: "text", text: "third" }]);
  h.calls[2].text("done"); h.calls[2].finish();
  await next.result();
});

test("an Agent forked with the caller's context starts from the caller's CC session", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("hello")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  h.calls[0].text("hello back"); h.calls[0].finish();
  const answer = await first.result(), childSaved = [];
  const child = createClaudeBridge({ cwd: () => directory, sessionId: () => "child", save: (state) => childSaved.push(state), clear() {},
    forkSources: () => h.bridge.points(), query: h.query });
  t.after(() => child.reset());
  const stream = child.streamSimple(model, ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools: [tool],
    messages: [...history, answer, user("forked task")] }), { sessionId: "child" });
  await until(() => h.calls.length === 2 && h.calls[1].prompts.length === 1);
  assert.equal(h.calls[1].options.resume, h.saved[0].sessionId);
  assert.equal(h.calls[1].options.forkSession, true);
  h.calls[1].text("child done"); h.calls[1].finish();
  await stream.result();
  assert.equal(childSaved[0].sessionId, h.calls[1].sessionId);
  assert.equal(existsSync(sessions.getSessionPath(h.calls[1].sessionId, directory)), true);
});

test("unknown tool names are left to Claude Code instead of ending the turn", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const stream = h.stream([user("run it")]);
  await until(() => h.calls.length === 1);
  const q = h.calls[0];
  q.begin();
  q.event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-x", name: "mcp:pi__echo", input: {} } });
  q.event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
  q.event({ type: "content_block_stop", index: 0 });
  q.event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
  q.event({ type: "message_stop" });
  q.text("retried"); q.finish();
  const answer = await stream.result();
  assert.equal(answer.stopReason, "stop");
  assert.deepEqual(answer.content, [{ type: "text", text: "retried" }]);
  // Both API calls count toward output and cost; context tokens come from the last call.
  const single = ai.calculateCost(model, { input: 7, output: 0, cacheRead: 2000, cacheWrite: 40, totalTokens: 0, cost: {} });
  assert.equal(answer.usage.output, 17);
  assert.equal(answer.usage.totalTokens, 2059);
  assert.ok(Math.abs(answer.usage.cost.cacheRead - 2 * single.cacheRead) < 1e-12);
});

test("a tool gap with an unknown tool name is not a resume point until the results are recorded", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const first = h.stream([user("run both")]);
  await until(() => h.calls.length === 1);
  const q = h.calls[0];
  q.begin();
  for (const [index, id, name] of [[0, "call-a", "mcp__pi__echo"], [1, "call-x", "mcp:pi__echo"]]) {
    q.event({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
    q.event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ value: id }) } });
    q.event({ type: "content_block_stop", index });
  }
  q.event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
  q.event({ type: "message_stop" });
  q.record(["call-a", "call-x"]);
  const answer = await first.result();
  assert.equal(answer.stopReason, "toolUse");
  await tick(); await tick();
  assert.equal(h.saved.length, 0);
});

test("SDK errors, early abort and malformed schemas terminate rather than hang", { timeout: 10000 }, async (t) => {
  const h = harness(t), controller = new AbortController(); controller.abort();
  assert.equal((await h.stream([user("abort")], { signal: controller.signal }).result()).stopReason, "aborted");
  assert.equal(h.calls.length, 0);
  const invalid = h.stream([user("invalid")], {}, [{ ...tool, parameters: { type: "string" } }]);
  assert.match((await invalid.result()).errorMessage, /must be an object schema/);
  const failed = h.stream([user("failure")]);
  await until(() => h.calls.length === 1);
  h.calls[0].emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["transport failed"] });
  assert.equal((await failed.result()).errorMessage, "Claude Code: server_error\ntransport failed");
  await until(() => h.calls[0].closed);
  assert.equal(h.saved.length, 0);
});

test("errors name their retry class from Claude Code's structured signals", async (t) => {
  const h = harness(t);
  const typed = (error, text, status) => (call) => {
    if (status) call.emit({ type: "rate_limit_event", rate_limit_info: { status } });
    call.emit({ type: "assistant", error, message: { content: [{ type: "text", text }] } });
  };
  for (const [label, fail, retryable] of [
    ["dropped connection", typed("server_error", "API Error: Connection dropped (ECONNRESET)"), true],
    ["overload", typed("overloaded", "API Error: 529 Overloaded"), true],
    ["throttle", typed("rate_limit", "API Error: Rate limit reached", "allowed_warning"), true],
    ["reached plan limit", typed("rate_limit", "You've hit your weekly limit · resets Mon 9am", "rejected"), false],
    ["reached spend cap", typed("rate_limit", "You're out of usage credits", "rejected"), false],
    ["limit wording without a rejected event", typed("rate_limit", "You've hit your weekly limit"), true],
    ["organization policy", typed("rate_limit", "Your usage allocation has been disabled by your admin"), false],
    ["unknown", typed("unknown", "Something odd"), true],
    ["authentication", typed("authentication_failed", "Please run /login"), false],
    ["invalid request", typed("invalid_request", "API Error: 400 messages: text content blocks must be non-empty"), false],
    ["billing", typed("billing_error", "Credit balance is too low"), false],
    ["model", typed("model_not_found", "There's an issue with the selected model"), false],
    ["execution error", (call) => call.emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Aborted by user"] }), true],
    ["process exit", (call) => call.fail(new Error("Claude Code process exited with code 1")), true],
    ["incomplete stream", (call) => call.emit({ type: "result", subtype: "success", is_error: false, result: "" }), true],
    ["closed stream", (call) => call.close(), true],
    ["unsupported stream", (call) => { call.begin(); call.event({ type: "content_block_start", index: 0, content_block: { type: "future_block" } }); }, false],
  ]) {
    const response = h.stream([user(label)]);
    const index = h.calls.length;
    await until(() => h.calls.length === index + 1);
    fail(h.calls[index]);
    const answer = await response.result();
    assert.equal(answer.stopReason, "error", label);
    assert.equal(ai.isRetryableAssistantError(answer), retryable, `${label}: ${answer.errorMessage}`);
    assert.equal(ai.isContextOverflow(answer, model.contextWindow), false, label);
  }
});

test("a resume rejected before init retries by rebuilding, never at the same point", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const turn = async (messages, i) => {
    const stream = h.stream(messages);
    await until(() => h.calls.length === i + 1);
    h.calls[i].text(`answer ${i}`); h.calls[i].finish();
    return stream.result();
  };
  const u1 = user("first"), a1 = await turn([u1], 0);
  const u2 = user("second"), a2 = await turn([u1, a1, u2], 1);
  const history = [u1, a1, u2, a2, user("third")], resumes = [];
  h.initless();
  // The saved point is rejected, then the prefix session cut at the first point; Pi's retries then rebuild.
  for (const [i, trace] of [[2, "resume: unchanged history"], [3, "prefix: Pi history changed after a resume point"], [4, "rebuild: Pi history changed or no saved session"]]) {
    const traces = h.traces.length, response = h.stream(history);
    await until(() => h.calls.length === i + 1);
    resumes.push(h.calls[i].options.resume);
    assert.ok(h.traces.slice(traces).includes(trace), trace);
    h.calls[i].emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: [`No message found with message.uuid of: ${h.calls[i].options.resumeSessionAt}`] });
    const answer = await response.result();
    assert.equal(ai.isRetryableAssistantError(answer), true, answer.errorMessage);
  }
  assert.equal(new Set(resumes).size, 3);
});

test("Pi's text reaches Claude Code verbatim, without command dispatch or file expansion", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const stream = h.stream([user("/cost @/etc/hosts")]);
  await until(() => h.calls.length === 1 && h.calls[0].prompts.length === 1);
  assert.equal(h.calls[0].options.verbatimPrompts, true);
  assert.deepEqual(h.calls[0].prompts[0].message.content, [{ type: "text", text: "/cost @/etc/hosts" }]);
  h.calls[0].text("ok"); h.calls[0].finish();
  await stream.result();
});

test("refusals and safety stops end as errors Pi does not retry; a full context window ends as length", async (t) => {
  const h = harness(t);
  const stopWith = async (reason, details) => {
    const response = h.stream([user(reason)]);
    const index = h.calls.length;
    await until(() => h.calls.length === index + 1);
    const q = h.calls[index];
    q.begin();
    q.event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    q.event({ type: "content_block_stop", index: 0 });
    q.event({ type: "message_delta", delta: { stop_reason: reason, ...details && { stop_details: details } }, usage: { output_tokens: 1 } });
    q.event({ type: "message_stop" });
    q.finish();
    return response.result();
  };
  const refused = await stopWith("refusal", { type: "refusal", explanation: "This request asks for harmful content." });
  assert.equal(refused.stopReason, "error");
  assert.equal(refused.errorMessage, "Claude declined to answer: This request asks for harmful content. Rephrase the request or choose another model.");
  assert.equal(ai.isRetryableAssistantError(refused), false);
  const retryWords = await stopWith("refusal", { type: "refusal", explanation: "I cannot help bypass rate limits." });
  assert.equal(retryWords.errorMessage, "Claude declined to answer this request. Rephrase the request or choose another model.");
  assert.equal(ai.isRetryableAssistantError(retryWords), false);
  const bare = await stopWith("refusal");
  assert.equal(bare.errorMessage, "Claude declined to answer this request. Rephrase the request or choose another model.");
  const flagged = await stopWith("sensitive");
  assert.equal(flagged.errorMessage, "Claude stopped because a safety filter flagged the content. Rephrase the request or choose another model.");
  assert.equal(ai.isRetryableAssistantError(flagged), false);
  assert.equal((await stopWith("model_context_window_exceeded")).stopReason, "length");
});

test("Pi's timeout ends a silent Claude Code, but never inside an API message or the tool gap", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const silent = h.stream([user("hang")], { timeoutMs: 50 });
  await until(() => h.calls.length === 1);
  const timedOut = await silent.result();
  assert.equal(timedOut.errorMessage, "Claude Code timed out: no response for 0 seconds.");
  assert.equal(ai.isRetryableAssistantError(timedOut), true);
  // A long silence inside an API message (thinking) and in the tool gap is left alone.
  const thinking = h.stream([user("think")], { timeoutMs: 50 });
  await until(() => h.calls.length === 2);
  const q = h.calls[1];
  q.begin();
  await new Promise((resolve) => setTimeout(resolve, 150));
  q.event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-a", name: "mcp__pi__echo", input: {} } });
  q.event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
  q.event({ type: "content_block_stop", index: 0 });
  q.event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
  q.event({ type: "message_stop" });
  const toolUse = await thinking.result();
  assert.equal(toolUse.stopReason, "toolUse");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(q.closed, false);
});

test("context errors enable compaction instead of retrying unchanged history", async (t) => {
  const h = harness(t), stream = h.stream([user("large")]);
  await until(() => h.calls.length === 1);
  h.calls[0].emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["prompt is too long: 210000 tokens"] });
  const answer = await stream.result();
  assert.equal(ai.isContextOverflow(answer, model.contextWindow), true);
  assert.equal(ai.isRetryableAssistantError(answer), false);
});

test("usage-credit rejections never retry or launch subsequent requests", async (t) => {
  const h = harness(t), stream = h.stream([user("billing")]);
  await until(() => h.calls.length === 1);
  h.calls[0].emit({ type: "assistant", error: "rate_limit", message: {
    content: [{ type: "text", text: "429: third-party apps now draw from your extra usage" }],
  } });
  const answer = await stream.result();
  assert.equal(answer.stopReason, "error");
  assert.equal(ai.isRetryableAssistantError(answer), false);
  assert.equal((await h.stream([user("blocked retry")]).result()).stopReason, "error");
  assert.equal(h.calls.length, 1);
});

test("usage-credit events stop generation and block later requests, including a tool-gap event", { timeout: 3000 }, async (t) => {
  for (const gap of [false, true]) {
    const h = harness(t), history = [user("credits")], stream = h.stream(history);
    await until(() => h.calls.length === 1);
    const q = h.calls[0];
    let answer, pending;
    if (gap) {
      const client = await q.client();
      q.tools(["call-a"]); answer = await stream.result();
      pending = callTool(client, "call-a");
      await tick();
    }
    q.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } });
    await tick();
    await until(() => q.closed);
    if (pending) assert.equal((await pending).isError, true);
    else {
      answer = await stream.result();
      assert.equal(answer.stopReason, "error");
      assert.equal(ai.isRetryableAssistantError(answer), false);
    }
    h.bridge.reset();
    const next = await h.stream(gap ? [...history, answer, result("call-a", "done")] : history).result();
    assert.match(next.errorMessage, /Claude Code billing/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.saved.length, 0);
  }
});

test("usage-credit stop closes concurrent initialization and pending MCP results", async (t) => {
  let checks = 0, finishCheck;
  const h = harness(t, () => ++checks === 2
    ? new Promise((resolve) => { finishCheck = resolve; })
    : Promise.resolve({ apiProvider: "firstParty", subscriptionType: "max", apiKeySource: "oauth" }));
  const first = h.stream([user("active")]);
  await until(() => h.calls.length === 1);
  const initializing = h.stream([user("waiting for auth")], { sessionId: "auxiliary" });
  await until(() => h.calls.length === 2);
  assert.equal(h.calls[1].prompts.length, 0);
  const toolStream = h.stream([user("pending tool")], { sessionId: "tool-session" });
  await until(() => h.calls.length === 3);
  const client = await h.calls[2].client();
  h.calls[2].tools(["call-a"]); await toolStream.result();
  const pending = callTool(client, "call-a"); await tick();
  h.calls[0].emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } });
  assert.match((await first.result()).errorMessage, /Claude Code billing/);
  assert.match((await initializing.result()).errorMessage, /Claude Code billing/);
  assert.equal((await pending).isError, true);
  assert.ok(h.calls.every((call) => call.closed));
  finishCheck({ apiProvider: "firstParty", subscriptionType: "max" });
  await tick();
  assert.equal(h.calls[1].prompts.length, 0);
});

test("credits_required refuses generation without waiting for an overage charge", async (t) => {
  const h = harness(t), stream = h.stream([user("credits required")]);
  await until(() => h.calls.length === 1);
  h.calls[0].emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", errorCode: "credits_required" } });
  const answer = await stream.result();
  assert.match(answer.errorMessage, /Claude Code billing/);
  assert.equal(ai.isRetryableAssistantError(answer), false);
  await until(() => h.calls[0].closed);
});

test("ordinary subscription rate-limit events do not stop responses", async (t) => {
  const h = harness(t), stream = h.stream([user("plan")]);
  await until(() => h.calls.length === 1);
  h.calls[0].emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", isUsingOverage: false } });
  h.calls[0].text("plan response"); h.calls[0].finish();
  assert.equal((await stream.result()).stopReason, "stop");
});

test("changed tool declarations rebuild a paused query and none suppresses all tools", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("tool")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  h.calls[0].tools(["call-a"]); const answer = await first.result();
  const next = h.stream([...history, answer, result("call-a", "done")], { toolChoice: "none" });
  await until(() => h.calls.length === 2);
  await until(() => h.calls[0].closed);
  assert.deepEqual(h.calls[1].options.mcpServers, {});
  h.calls[1].text("done"); h.calls[1].finish();
  assert.equal((await next.result()).stopReason, "stop");
});

test("thinking budgets, redacted signatures and authentication errors survive the SDK boundary", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const stream = h.stream([user("think")], { reasoning: "low", maxTokens: 2000, thinkingBudgets: { low: 1200 } });
  await until(() => h.calls.length === 1);
  const q = h.calls[0];
  assert.deepEqual(q.options.thinking, { type: "enabled", budgetTokens: 1200, display: "summarized" });
  assert.equal(q.options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "3200");
  q.begin();
  q.event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
  q.event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "considering" } });
  q.event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } });
  q.event({ type: "content_block_stop", index: 0 });
  q.event({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } });
  q.event({ type: "content_block_stop", index: 1 });
  q.event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
  q.event({ type: "message_stop" }); q.finish();
  const answer = await stream.result();
  assert.equal(answer.content[0].thinkingSignature, "signed");
  assert.equal(answer.content[1].redacted, true);
  const imported = h.stream([user("rewritten"), answer, user("continue")]);
  await until(() => h.calls.length === 2);
  const history = readFileSync(sessions.getSessionPath(h.calls[1].options.resume, directory), "utf8");
  const blocks = history.trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "assistant")
    .flatMap((entry) => entry.message.content);
  assert.deepEqual(blocks.filter((block) => block.type === "redacted_thinking"), [
    { type: "redacted_thinking", data: "opaque" },
  ]);
  h.calls[1].emit({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Token expired: log in again" }] } });
  assert.match((await imported.result()).errorMessage, /Token expired: log in again/);
  const short = h.stream([user("short thought")], { reasoning: "minimal", maxTokens: 128 });
  await until(() => h.calls.length === 3);
  assert.deepEqual(h.calls[2].options.thinking, { type: "enabled", budgetTokens: 1024, display: "summarized" });
  assert.equal(h.calls[2].options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "2048");
  h.calls[2].text("short answer"); h.calls[2].finish();
  assert.equal((await short.result()).stopReason, "stop");
});

test("session changes during an asynchronous payload hook cannot launch stale requests", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  let resume;
  const pending = h.stream([user("stale")], { onPayload: () => new Promise((resolve) => { resume = resolve; }) });
  h.bridge.reset();
  resume();
  assert.match((await pending.result()).errorMessage, /session context changed/);
  assert.equal(h.calls.length, 0);
});

test("production loader registers the provider and session lifecycle without plugin dependencies", async () => {
  const loader = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/extensions/loader.js")));
  const core = await import(pathToFileURL(join(PI_PACKAGE, "dist/index.js")));
  const loaded = await loader.loadExtensions([join(CUSTOM, "claude.ts")], directory);
  assert.deepEqual(loaded.errors, []);
  const session = core.SessionManager.inMemory(directory);
  const runtime = await core.ModelRuntime.create({ modelsPath: null, authPath: join(directory, "auth.json"), refreshOnCreate: false });
  const registry = new core.ModelRegistry(runtime);
  const runner = new core.ExtensionRunner(loaded.extensions, loaded.runtime, directory, session, registry);
  const errors = []; runner.onError((error) => errors.push(error));
  runner.bindCore({}, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, hasPendingMessages: () => false });
  await runner.emit({ type: "session_start", reason: "startup" });
  const registeredModel = registry.find("claude-code", "claude-haiku-4-5");
  assert.ok(registeredModel);
  let observed;
  const intercepted = await registry.streamSimple(registeredModel,
    { systemPrompt: "Pi prompt", messages: [user("do not send")], tools: [tool] },
    { onPayload: (payload) => { observed = payload; throw new Error("test interception"); } }).result();
  assert.equal(intercepted.errorMessage, "test interception");
  assert.equal(observed.systemPrompt, "Pi prompt");
  assert.deepEqual(observed.tools, [tool]);
  assert.equal(observed.messages[0].content, "do not send");
  await runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
  await runner.emit({ type: "session_shutdown", reason: "new" });
  await runner.emit({ type: "session_start", reason: "new" });
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  runner.invalidate();
  assert.deepEqual(errors, []);
});

test("a Session sharing the model runtime keeps its provider state after another Session ends", async () => {
  const loader = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/extensions/loader.js")));
  const core = await import(pathToFileURL(join(PI_PACKAGE, "dist/index.js")));
  const runtime = await core.ModelRuntime.create({ modelsPath: null, authPath: join(directory, "auth.json"), refreshOnCreate: false });
  async function start() {
    const loaded = await loader.loadExtensions([join(CUSTOM, "claude.ts")], directory);
    const session = core.SessionManager.inMemory(directory);
    const registry = new core.ModelRegistry(runtime);
    const runner = new core.ExtensionRunner(loaded.extensions, loaded.runtime, directory, session, registry);
    runner.bindCore({}, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, hasPendingMessages: () => false });
    await runner.emit({ type: "session_start", reason: "startup" });
    return { session, registry, runner };
  }
  const main = await start();
  const child = await start();
  await child.runner.emit({ type: "session_shutdown", reason: "quit" });
  child.runner.invalidate();
  const registeredModel = main.registry.find("claude-code", "claude-haiku-4-5");
  const reply = await main.registry.streamSimple(registeredModel,
    { systemPrompt: "Pi prompt", messages: [user("do not send")], tools: [{ ...tool, parameters: { type: "string" } }] },
    { sessionId: main.session.getSessionId() }).result();
  // The invalid schema stops the request after Session state is read and before Claude Code starts.
  assert.match(reply.errorMessage, /must be an object schema/);
  await main.runner.emit({ type: "session_shutdown", reason: "quit" });
  main.runner.invalidate();
});
