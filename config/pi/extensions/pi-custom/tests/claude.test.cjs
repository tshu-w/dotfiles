const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, realpathSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const CUSTOM = join(__dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "pi-claude-test-"));
process.env.CLAUDE_CONFIG_DIR = join(directory, "claude");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));
const jiti = createJiti(__filename, {
  alias: {
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
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  throw new Error("Expected asynchronous state was not reached");
}

before(async () => {
  ({ createClaudeBridge } = await jiti.import(join(CUSTOM, "claude/bridge.ts")));
  ai = await jiti.import("@earendil-works/pi-ai");
  sessions = await import(pathToFileURL(join(CUSTOM, "node_modules/cc-session-io/dist/index.js")));
  ({ Client } = await import(pathToFileURL(join(CUSTOM, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"))));
  ({ InMemoryTransport } = await import(pathToFileURL(join(CUSTOM, "node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js"))));
  model = { ...ai.getModel("anthropic", "claude-haiku-4-5"), provider: "claude-code", api: "claude-code" };
});

function harness(t) {
  const calls = [], saved = [], traces = [];
  const query = ({ prompt, options }) => {
    const queue = [];
    let wake, closed = false;
    const session = sessions.createSession({ projectPath: directory });
    session.addUserMessage("fixture");
    const uuid = session.addAssistantMessage([{ type: "text", text: "fixture" }]);
    session.save();
    const call = {
      options, prompts: [], sessionId: options.resume ?? session.sessionId, uuid,
      get closed() { return closed; },
      emit(message) { queue.push(message); wake?.(); wake = undefined; },
      event(event) { this.emit({ type: "stream_event", parent_tool_use_id: null, event }); },
      close() { closed = true; wake?.(); wake = undefined; },
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          if (!queue.length) await new Promise((resolve) => { wake = resolve; });
          while (queue.length && !closed) yield queue.shift();
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
    call.emit({ type: "system", subtype: "init", session_id: call.sessionId });
    void (async () => { try { for await (const message of prompt) call.prompts.push(message); } catch {} })();
    return call;
  };
  const bridge = createClaudeBridge({ cwd: () => directory, sessionId: () => "pi-main", save: (state) => saved.push(state), query, trace: (message) => traces.push(message) });
  t.after(() => bridge.dispose());
  const stream = (messages, options = {}, tools = [tool]) => bridge.streamSimple(model,
    ai.normalizeContext({ systemPrompt: "Use Pi tools only.", tools, messages }), { sessionId: "pi-main", ...options });
  return { bridge, calls, saved, traces, stream };
}

const callTool = (client, id) => client.callTool({ name: "echo", arguments: { value: id }, _meta: { "claudecode/toolUseId": id } });

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
  assert.ok(h.calls[0].closed);
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

test("Claude preset retains current Pi constraints and routes their tool references through MCP", { timeout: 10000 }, async (t) => {
  const { buildSystemPromptState } = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/system-prompt.js")));
  const state = buildSystemPromptState({
    cwd: directory, selectedTools: ["read", "echo"],
    toolSnippets: { read: "Read files", echo: "Echo input" },
    toolGuidelines: { echo: ["Use echo to inspect input.", "Use `echo` before echo(value)."] },
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
  assert.match(prompt.append, /Use the mcp__pi__read tool/);
  assert.match(prompt.append, /Keep read-only paths and echo\.txt unchanged/);
  const client = await q.client();
  for (const { name } of (await client.listTools()).tools) assert.ok(prompt.append.includes(`mcp__pi__${name}`));
  assert.deepEqual(messages, before);
  q.text("checked"); q.finish();
  assert.equal((await stream.result()).stopReason, "stop");
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
  const cases = [
    { state, retained: Object.values(state.sections) },
    { state: withDocsAddition, retained: [withDocsAddition.sections.docs] },
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
  assert.ok(h.calls[0].closed);
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

test("abort during the tool gap releases MCP and retry rebuilds from Pi history", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("tool")], controller = new AbortController();
  const first = h.stream(history, { signal: controller.signal });
  await until(() => h.calls.length === 1);
  const q = h.calls[0], client = await q.client();
  q.tools(["call-a"]); const answer = await first.result();
  const pending = callTool(client, "call-a");
  await tick(); controller.abort();
  assert.equal((await pending).isError, true);
  assert.equal(q.closed, true);
  assert.equal(answer.stopReason, "toolUse");
  const retry = h.stream([...history, answer, result("call-a", "retried")]);
  await until(() => h.calls.length === 2);
  assert.ok(h.calls[1].options.resume);
  assert.notEqual(h.calls[1].options.resume, q.sessionId);
  h.calls[1].text("recovered"); h.calls[1].finish();
  assert.equal((await retry.result()).stopReason, "stop");
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

test("SDK errors, early abort and malformed schemas terminate rather than hang", { timeout: 10000 }, async (t) => {
  const h = harness(t), controller = new AbortController(); controller.abort();
  assert.equal((await h.stream([user("abort")], { signal: controller.signal }).result()).stopReason, "aborted");
  assert.equal(h.calls.length, 0);
  const invalid = h.stream([user("invalid")], {}, [{ ...tool, parameters: { type: "string" } }]);
  assert.match((await invalid.result()).errorMessage, /must be an object schema/);
  const failed = h.stream([user("failure")]);
  await until(() => h.calls.length === 1);
  h.calls[0].emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["transport failed"] });
  assert.equal((await failed.result()).errorMessage, "transport failed");
  assert.equal(h.calls[0].closed, true);
  assert.equal(h.saved.length, 0);
});

test("changed tool declarations rebuild a paused query and none suppresses all tools", { timeout: 10000 }, async (t) => {
  const h = harness(t), history = [user("tool")];
  const first = h.stream(history);
  await until(() => h.calls.length === 1);
  h.calls[0].tools(["call-a"]); const answer = await first.result();
  const next = h.stream([...history, answer, result("call-a", "done")], { toolChoice: "none" });
  await until(() => h.calls.length === 2);
  assert.equal(h.calls[0].closed, true);
  assert.deepEqual(h.calls[1].options.mcpServers, {});
  h.calls[1].text("done"); h.calls[1].finish();
  assert.equal((await next.result()).stopReason, "stop");
});

test("thinking budgets, redacted signatures and authentication errors survive the SDK boundary", { timeout: 10000 }, async (t) => {
  const h = harness(t);
  const stream = h.stream([user("think")], { reasoning: "low", maxTokens: 2000, thinkingBudgets: { low: 1200 } });
  await until(() => h.calls.length === 1);
  const q = h.calls[0];
  assert.deepEqual(q.options.thinking, { type: "enabled", budgetTokens: 1200 });
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
  assert.match(history, /"type":"redacted_thinking","data":"opaque"/);
  h.calls[1].emit({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Token expired: log in again" }] } });
  assert.match((await imported.result()).errorMessage, /Token expired: log in again/);
  const short = h.stream([user("short thought")], { reasoning: "minimal", maxTokens: 128 });
  await until(() => h.calls.length === 3);
  assert.deepEqual(h.calls[2].options.thinking, { type: "enabled", budgetTokens: 1024 });
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
  const registration = loaded.runtime.pendingProviderRegistrations.find((r) => r.name === "claude-code");
  assert.ok(registration.config.models.some((m) => m.id === "claude-haiku-4-5"));
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
