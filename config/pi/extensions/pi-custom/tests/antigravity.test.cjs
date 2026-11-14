const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { execFileSync } = require("node:child_process");
const { realpathSync, mkdtempSync, writeFileSync, rmSync } = require("node:fs");
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
let createAntigravityBridge, registerAntigravity, ai, model;
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
  model = { ...ai.getModel("anthropic", "claude-haiku-4-5"), id: "gemini-test", provider: "antigravity", api: "antigravity" };
});

function harness(t, initialized = { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } }, session = {}) {
  const connections = [];
  const bridge = createAntigravityBridge({ cwd: () => CUSTOM, connect: async (cwd, handlers, tools) => {
    const connection = {
      cwd, handlers, tools, initialized, mcpServer: { name: "pi-bridge", type: "http", url: "http://fixture.invalid/mcp" },
      calls: [], prompts: [], watchdogs: [], closed: false,
      close() { this.closed = true; },
      setPromptWatchdog(sessionId, settings) { this.watchdogs.push({ sessionId, settings }); },
      request(method, params, settings) {
        this.calls.push({ method, params });
        if (method === "session/new") return Promise.resolve({ sessionId: `session-${connections.length}`, ...session });
        if (method === "session/set_config_option" || method === "session/set_model") return Promise.resolve({});
        if (method === "session/prompt") {
          const pending = deferred();
          this.prompts.push({ params, settings, ...pending });
          return pending.promise;
        }
        throw new Error(`Unexpected request: ${method}`);
      },
      chunk(text, sessionUpdate = "agent_message_chunk", sessionId = `session-${connections.indexOf(this) + 1}`) {
        handlers.update({ sessionId, update: { sessionUpdate, content: { type: "text", text } } });
      },
      finish(response = { stopReason: "end_turn" }) { this.prompts.at(-1).resolve(response); },
    };
    connections.push(connection);
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

test("text and thinking chunks have balanced events and quota usage includes caches", { timeout: 3000 }, async (t) => {
  const h = harness(t), { stream, connection } = await started(h, [user("hello")]);
  assert.deepEqual(connection.tools, [tool]);
  const session = connection.calls[0];
  assert.equal(session.method, "session/new");
  assert.equal(session.params.cwd, CUSTOM);
  assert.deepEqual(session.params.mcpServers, [connection.mcpServer]);
  assert.deepEqual(session.params._meta.antigravity.enabledTools, []);
  assert.deepEqual(session.params._meta.antigravity.eagerMcpServers, ["pi-bridge"]);
  assert.match(session.params._meta.antigravity.systemPrompt.append, /Use Pi tools only\./);
  connection.chunk("ignored", "agent_message_chunk", "unrelated-session");
  connection.chunk("pl", "agent_thought_chunk"); connection.chunk("an", "agent_thought_chunk");
  connection.chunk("hello"); connection.chunk(" back");
  connection.finish({ stopReason: "end_turn", usage: { inputTokens: 999, outputTokens: 999, cachedReadTokens: 4, cachedWriteTokens: 2, thoughtTokens: 3 }, _meta: { quota: { token_count: { input_tokens: 20, output_tokens: 7 } } } });
  const answer = await stream.result();
  assert.equal(answer.stopReason, "stop");
  assert.deepEqual(answer.content, [{ type: "thinking", thinking: "plan" }, { type: "text", text: "hello back" }]);
  assert.deepEqual([answer.usage.input, answer.usage.output, answer.usage.cacheRead, answer.usage.cacheWrite, answer.usage.totalTokens], [16, 10, 4, 2, 32]);
  const events = []; for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ["start", "thinking_start", "thinking_delta", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end", "done"]);
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

test("unchanged history reuses its session and sends only the new user input", { timeout: 3000 }, async (t) => {
  const h = harness(t), history = [user("first")];
  const { stream, connection } = await started(h, history);
  connection.chunk("answer"); connection.finish();
  const answer = await stream.result();
  const second = h.stream([...history, answer, user("next")]);
  await until(() => connection.prompts.length === 2);
  assert.equal(h.connections.length, 1);
  assert.equal(connection.calls.filter((call) => call.method === "session/new").length, 1);
  assert.deepEqual(connection.prompts[1].params, { sessionId: "session-1", prompt: [{ type: "text", text: "next" }] });
  connection.chunk("done"); connection.finish();
  assert.equal((await second.result()).stopReason, "stop");
});

test("policy changes open a new session and replay the full history as a resource", { timeout: 3000 }, async (t) => {
  const h = harness(t), history = [user("first")];
  const { stream, connection } = await started(h, history);
  connection.chunk("answer"); connection.finish();
  const messages = [...history, await stream.result(), user("next")];
  const next = await started(h, messages, 1, {}, "Require approval.");
  assert.equal(connection.closed, true);
  assert.match(next.connection.calls[0].params._meta.antigravity.systemPrompt.append, /Require approval\./);
  const prompt = next.connection.prompts[0].params.prompt;
  assert.equal(prompt[0].type, "resource");
  assert.equal(prompt[0].resource.uri, "pi://conversation/history");
  assert.equal(prompt[0].resource.mimeType, "text/plain");
  assert.deepEqual(JSON.parse(prompt[0].resource.text.split("\n").slice(1).join("\n")), messages.slice(0, -1));
  assert.deepEqual(prompt[2], { type: "text", text: "next" });
  next.connection.chunk("continued"); next.connection.finish();
  assert.equal((await next.stream.result()).stopReason, "stop");
});

test("reconstruction keeps historical and latest images outside transcript text with their positions", async (t) => {
  const h = harness(t);
  const oldImage = { type: "image", mimeType: "image/png", data: "OLD_IMAGE_BASE64" };
  const toolImage = { type: "image", mimeType: "image/png", data: "TOOL_IMAGE_BASE64" };
  const newImage = { type: "image", mimeType: "image/jpeg", data: "NEW_IMAGE_BASE64" };
  const messages = [user([oldImage, { type: "text", text: "old question" }]),
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "old" } }], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "call-1", toolName: "echo", content: [{ type: "text", text: "screenshot" }, toolImage], isError: false },
    user([{ type: "text", text: "compare now" }, newImage])];
  const { stream, connection } = await started(h, messages);
  const prompt = connection.prompts[0].params.prompt;
  const transcript = prompt[0].resource.text;
  assert.doesNotMatch(transcript, /BASE64|compare now/);
  const history = JSON.parse(transcript.split("\n").slice(1).join("\n"));
  assert.equal(history.length, 3);
  assert.equal(history[2].toolCallId, "call-1");
  assert.equal(history[0].content[0].attachment, "pi://conversation/history/0/0");
  assert.equal(history[2].content[1].attachment, "pi://conversation/history/2/1");
  assert.deepEqual(prompt.filter((block) => block.type === "image"), [oldImage, toolImage, newImage]);
  assert.ok(prompt.some((block) => block.type === "text" && block.text.includes("pi://conversation/history/2/1")));
  assert.deepEqual(prompt.slice(-2), [{ type: "text", text: "compare now" }, newImage]);
  connection.chunk("compared"); connection.finish();
  assert.equal((await stream.result()).stopReason, "stop");
  const resumed = await started(h, messages.slice(0, -1), 1);
  const replay = resumed.connection.prompts[0].params.prompt;
  assert.deepEqual(replay.filter((block) => block.type === "image"), [oldImage, toolImage]);
  assert.equal(JSON.parse(replay[0].resource.text.split("\n").slice(1).join("\n")).at(-1).toolCallId, "call-1");
  assert.doesNotMatch(replay[0].resource.text, /BASE64/);
  resumed.connection.chunk("resumed"); resumed.connection.finish();
  assert.equal((await resumed.stream.result()).stopReason, "stop");
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
  assert.deepEqual(final.content, [{ type: "text", text: "finished" }]);
});

test("a failed original prompt terminates the stream attached after a tool result", { timeout: 3000 }, async (t) => {
  const h = harness(t), history = [user("use echo")];
  const { stream, connection } = await started(h, history);
  const pending = connection.handlers.tool("echo", { value: "hello" });
  const answer = await stream.result();
  const result = { role: "toolResult", toolCallId: answer.content[0].id, toolName: "echo", content: [{ type: "text", text: "done" }], isError: false, timestamp: 0 };
  const next = h.stream([...history, answer, result]);
  await pending;
  connection.prompts[0].reject(new Error("Original ACP prompt failed"));
  const failure = await next.result();
  assert.equal(failure.stopReason, "error");
  assert.match(failure.errorMessage, /Original ACP prompt failed/);
  assert.equal(connection.closed, true);
  const events = []; for await (const event of next) events.push(event.type);
  assert.deepEqual(events, ["start", "error"]);
});

test("an update awaiting its hook cannot write into a new stream after reset", { timeout: 3000 }, async (t) => {
  const h = harness(t), hook = deferred();
  let entered = false;
  const first = await started(h, [user("first")], 0, { onProviderStreamEvent: async () => { entered = true; await hook.promise; } });
  first.connection.chunk("stale");
  await until(() => entered);
  h.bridge.reset();
  assert.equal((await first.stream.result()).stopReason, "error");
  const next = await started(h, [user("next")], 1);
  hook.resolve();
  await tick();
  first.connection.finish();
  next.connection.chunk("fresh"); next.connection.finish();
  assert.deepEqual((await next.stream.result()).content, [{ type: "text", text: "fresh" }]);
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

test("unknown system-prompt capability fails closed without sending a prompt", { timeout: 3000 }, async (t) => {
  for (const initialized of [{}, { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: false } } } } }]) {
    const h = harness(t, initialized);
    const answer = await h.stream([user("hello")]).result();
    assert.equal(answer.stopReason, "error");
    assert.match(answer.errorMessage, /requires systemPrompt\.append support; upgrade agy/);
    assert.equal(h.connections.length, 1);
    assert.equal(h.connections[0].closed, true);
    assert.deepEqual(h.connections[0].calls, []);
  }
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
});

const root = mkdtempSync(join(tmpdir(), "pi-acp-transport-"));
const executable = join(root, "mock-agy");
after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(executable, `#!${process.execPath}
const readline = require('node:readline');
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
    send(session.error ? {id:m.id,error:{code:-32000,message:'secret-upstream'}} : {id:m.id,result:session});
  } else if (m.method === 'activity') {
    send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'still working'}}}});
    send({id:m.id,result:{ok:true}});
  } else if (m.method === 'session/prompt') {
    if (m.params.wait) { send({method:'session/update',params:{sessionId:m.params.sessionId,waiting:true}}); return; }
    permissionPrompt = m.id;
    const cases = [
      {name:'mcp_pi-bridge_pi_echo'},
      {name:'run_command'},
      {name:'mcp_pi-bridge_pi_missing'},
      {name:'mcp_other_pi_echo'},
      {name:'mcp_pi-bridge_pi_echo',sessionId:'unrelated'},
      {title:'Run mcp_pi-bridge_pi_echo'},
    ];
    cases.forEach(({sessionId = m.params.sessionId, ...toolCall}, i) => send({id:'permission-'+i,method:'session/request_permission',params:{sessionId,toolCall,options:[{optionId:'always',kind:'allow_always'},{optionId:'once',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}}));
  } else if (m.method === 'exercise') {
    for (const [i, method] of ['session/request_permission','fs/read_text_file','fs/write_text_file','terminal/create','terminal/output','terminal/kill','terminal/release','terminal/wait_for_exit'].entries()) send({id:'agent-'+i,method,params:{options:[{optionId:'yes',kind:'allow_always'}]}});
    send({id:m.id,result:{ok:true}});
  } else if (m.method === 'crash') { process.stderr.write('secret-stderr'); process.exit(9); }
  else if (m.method === 'invalid') process.stdout.write('not-json\\n');
  else if (m.method === 'error') send({id:m.id,error:{code:-32000,message:'secret-upstream'}});
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
  assert.deepEqual(connection.initialized.argv, ["acp", "--disable-telemetry", "--include-default-customizations=false"]);
  assert.equal(connection.initialized.cwd, realpathSync(root));
  assert.equal(connection.initialized.home, process.env.HOME);
  assert.equal(connection.initialized.xdgConfig, process.env.XDG_CONFIG_HOME);
  assert.equal(connection.initialized.xdgData, process.env.XDG_DATA_HOME);
  assert.equal(connection.mcpServer.type, "http");
  assert.equal(connection.mcpServer.name, "pi-bridge");
  assert.equal(new URL(connection.mcpServer.url).hostname, "127.0.0.1");
  assert.equal((await fetch(connection.mcpServer.url)).status, 401);
  const headers = Object.fromEntries(connection.mcpServer.headers.map(({ name, value }) => [name, value]));
  const client = new Client({ name: "fixture", version: "1" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.mcpServer.url), { requestInit: { headers } }));
  assert.deepEqual((await client.listTools()).tools, [{ name: "pi_echo", description: "Echo a value", inputSchema: tools[0].parameters }]);
  assert.deepEqual(await client.callTool({ name: "pi_echo", arguments: { value: "hello" } }), { content: [{ type: "text", text: "hello" }], isError: false });
  assert.deepEqual(calls, [{ name: "echo", args: { value: "hello" } }]);
  const invalid = await client.callTool({ name: "pi_missing", arguments: {} }).catch((e) => e);
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
  await assert.rejects(connection.request("error", {}), (error) => /agy ACP rejected.*authentication required/.test(error.message) && !/secret-upstream|log in/.test(error.message));
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
  const rejected = assert.rejects(connection.request("session/prompt", { sessionId: "idle", wait: true }, { timeoutMs: 100 }), /timed out: session\/prompt/);
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
  const toolResult = client.callTool({ name: "pi_echo", arguments: { value: "hello" } }, undefined, { timeout: 2_000_000 });
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
  const cached = { id: "gemini-cached", name: "Cached", provider: "antigravity", api: "antigravity" };
  const rejected = ["default", "claude-opus-5-5", "gpt-oss-120b-medium", "Gemini-test", "gemini-"];
  const restored = await config.refreshModels(context({ stored: { checkedAt: 0, models: [cached,
    ...rejected.map(id => ({ ...cached, id })), { ...cached, id: "gemini-wrong-provider", provider: "other" },
  ] } }));
  assert.deepEqual(restored.map(model => model.id), ["gemini-cached"]);
  assert.ok(restored.every(model => model.compat?.supportsMidConvoSystemMessages === false));
  assert.deepEqual(await config.refreshModels(context()), []);
});

test("refresh discovers grouped model choices, deduplicates IDs and persists metadata only", async (t) => {
  fixture(t, undefined, { sessionId: "discovery", configOptions: [{ id: "model_id", type: "select", category: "model", options: [
    { value: "gemini-one", name: "First" }, { group: "Other", options: [{ value: "gemini-two", name: "Second" }, { value: "gemini-one", name: "Duplicate" }] },
    ...["default", "claude-opus-5-5", "gpt-oss-120b-medium", "gemini-"].map(value => ({ value, name: value })),
  ] }], models: { availableModels: [{ modelId: "legacy", name: "Ignored" }] } });
  const publications = [];
  const models = await provider().refreshModels(context({ allowNetwork: true, publish: async value => { publications.push(value); return true; } }));
  assert.deepEqual(models.map(model => [model.id, model.name]), [["gemini-one", "gemini-one"], ["gemini-two", "gemini-two"]]);
  assert.ok(models.every(model => model.compat?.supportsMidConvoSystemMessages === false));
  assert.equal(publications.length, 1);
  assert.deepEqual(publications[0].persist.models.map(model => model.id), ["gemini-one", "gemini-two"]);
  assert.ok(publications[0].persist.models.every(model => model.provider === "antigravity" && model.api === "antigravity"));
  assert.ok(!JSON.stringify(publications).includes("discovery"));
});

test("refresh supports legacy availableModels and leaves cache untouched on authentication or empty catalog errors", async (t) => {
  fixture(t, undefined, { sessionId: "legacy", models: { availableModels: [{ modelId: "gemini-legacy", name: "Legacy" }, { modelId: "claude-opus-5-5", name: "Excluded" }] } });
  assert.deepEqual((await provider().refreshModels(context({ allowNetwork: true }))).map(model => model.id), ["gemini-legacy"]);
  for (const session of [{ error: true }, { sessionId: "empty" }, { models: { availableModels: [{ modelId: "claude-opus-5-5" }] } }]) {
    fixture(t, undefined, session);
    let published = false;
    await assert.rejects(provider().refreshModels(context({ allowNetwork: true, publish: async () => { published = true; return true; } })), session.error ? /agy ACP rejected.*authentication required/ : /did not advertise any models/);
    assert.equal(published, false);
  }
});

test("native runtime refresh discovers real IDs and registers only antigravity", async (t) => {
  fixture(t, undefined, { configOptions: [{ id: "model", type: "select", options: [{ value: "gemini-test", name: "Different display label" }] }] });
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
  const model = runtime.getModel("antigravity", "gemini-test");
  assert.equal(model.name, model.id);
  assert.equal(model.provider, "antigravity");
  assert.ok(runtime.getAvailableSnapshot().some(model => model.provider === "antigravity" && model.id === "gemini-test"));
});


test("native refresh failure notifies the actual discovery error without upstream secrets", async (t) => {
  fixture(t, undefined, { error: true });
  const handlers = new Map(), notices = [];
  let config;
  registerAntigravity({ registerProvider(id, value) { if (id === "antigravity") config = value; }, on(event, handler) { handlers.set(event, handler); } });
  handlers.get("session_start")({}, { cwd: process.cwd(), sessionManager: { getSessionId: () => "catalog-error-test" }, ui: { notify: (...args) => notices.push(args) } });
  t.after(() => handlers.get("session_shutdown")());
  await assert.rejects(config.refreshModels(context({ allowNetwork: true })), /authentication required/);
  assert.equal(notices.length, 1);
  assert.match(notices[0][0], /Antigravity model discovery:.*authentication required/);
  assert.ok(!notices[0][0].includes("secret-upstream"));
});

