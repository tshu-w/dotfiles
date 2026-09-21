// Integration: real extension factories, runner, session context and compaction;
// only provider HTTP/WebSocket boundaries are replaced. Run with node --test.
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, realpathSync } = require("node:fs");
const { tmpdir, homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { zstdDecompressSync } = require("node:zlib");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const TAPE = resolve(process.env.PI_TAPE_EXTENSION ?? join(homedir(), ".config/pi/git/github.com/tshu-w/pi-tape/extensions/index.ts"));
const CUSTOM = join(__dirname, "../index.ts");
const agentDir = mkdtempSync(join(tmpdir(), "pi-tape-codex-integration-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

const model = {
	provider: "openai-codex", id: "gpt-5.6", api: "openai-codex-responses",
	baseUrl: "https://codex.test", input: ["text"], reasoning: true,
	contextWindow: 272_000, maxTokens: 16_384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const settings = { enabled: true, reserveTokens: 4096, keepRecentTokens: 20 };
const account = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
const auth = { ok: true, apiKey: `e30.${account}.sig` };
const artifact = { type: "compaction", encrypted_content: "test-artifact" };
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
let core, loader, prepareCompaction, builtinStreamSimple;
let requests = [];
let rejectRemote = false;

before(async () => {
	core = await import(pathToFileURL(join(PI_PACKAGE, "dist/index.js")).href);
	loader = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/extensions/loader.js")).href);
	({ prepareCompaction } = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/compaction/compaction.js")).href));
	({ streamSimple: builtinStreamSimple } = await import(pathToFileURL(join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/compat.js")).href));
	globalThis.WebSocket = undefined;
	globalThis.fetch = async (url, options) => {
		assert.equal(String(url), "https://codex.test/codex/responses");
		const body = JSON.parse(new Headers(options.headers).get("content-encoding") === "zstd"
			? zstdDecompressSync(options.body).toString("utf8")
			: options.body);
		const remote = body.input?.at(-1)?.type === "compaction_trigger";
		requests.push({ body, remote });
		if (remote && rejectRemote) return new Response("remote rejected", { status: 400 });
		const item = remote ? artifact : {
			type: "message", id: "msg_summary", role: "assistant", status: "completed",
			content: [{ type: "output_text", text: "Portable checkpoint summary.", annotations: [] }],
		};
		return new Response([
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp_summary", status: "completed", output: [item] } },
		].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	};
});
after(() => {
	globalThis.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
});

async function start(t, paths, { session = core.SessionManager.inMemory(agentDir), enabled = true, thinking = "high", reason = "startup", authenticate = async () => auth } = {}) {
	session.appendCustomEntry("pi-custom:settings", { codexCompaction: enabled });
	const loaded = await loader.loadExtensions(paths, agentDir);
	assert.deepEqual(loaded.errors, []);
	const runner = new core.ExtensionRunner(loaded.extensions, loaded.runtime, agentDir, session, {
		getApiKeyAndHeaders: authenticate,
		streamSimple: (...args) => builtinStreamSimple(...args),
		registerProvider() {},
		unregisterProvider() {},
	});
	const errors = [];
	runner.onError((error) => errors.push(error));
	runner.setUIContext(undefined, "print");
	runner.bindCore({
		getActiveTools: () => ["tape"],
		getAllTools: () => runner.getAllRegisteredTools().map(({ definition }) => definition),
		getThinkingLevel: () => thinking,
	}, {
		getModel: () => model,
		getScopedModels: () => [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 25_000, contextWindow: model.contextWindow }),
		getSystemPrompt: () => "Integration test system prompt.",
	});
	let stopped = false;
	const stop = async (reason = "quit") => {
		if (stopped) return;
		stopped = true;
		await runner.emit({ type: "session_shutdown", reason });
		runner.invalidate();
		assert.deepEqual(errors, []);
	};
	t?.after(() => stop());
	await runner.emit({ type: "session_start", reason });
	assert.deepEqual(errors, []);
	return { runner, session, errors, stop };
}

function user(content) {
	return { role: "user", content, timestamp: Date.now() };
}
function assistant(content) {
	return {
		role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
		stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
	};
}
async function anchor(runtime, name = "checkpoint") {
	const { session, runner } = runtime;
	session.appendMessage(user("DISCARDED_HISTORY " + "old ".repeat(25_000)));
	session.appendMessage(user("RECENT_HISTORY " + "recent ".repeat(12_000)));
	session.appendMessage(assistant([{ type: "toolCall", id: `call_${name}`, name: "tape", arguments: { action: "anchor", name, summary: "ANCHOR_CHECKPOINT" } }]));
	const result = await runner.getToolDefinition("tape").execute(`call_${name}`, {
		action: "anchor", name, summary: "ANCHOR_CHECKPOINT",
	}, new AbortController().signal, undefined, runner.createContext());
	session.appendMessage({ role: "toolResult", toolName: "tape", toolCallId: `call_${name}`, ...result, isError: false, timestamp: Date.now() });
	session.appendMessage(user("POST_ANCHOR_HISTORY " + "later ".repeat(100)));
	session.appendMessage(user("KEPT_TAIL"));
}
async function compact(runtime, reason = "threshold") {
	requests = [];
	const branchEntries = runtime.session.getBranch();
	const preparation = prepareCompaction(branchEntries, settings);
	assert.ok(preparation);
	const result = await runtime.runner.emit({
		type: "session_before_compact", branchEntries, preparation, reason,
		willRetry: reason === "overflow", signal: new AbortController().signal,
	});
	assert.deepEqual(runtime.errors, []);
	assert.match(result?.compaction?.summary ?? "", /Portable checkpoint summary/);
	assert.equal(result.compaction.tokensBefore, 25_000, "use effective context usage rather than raw branch tokens");
	return result.compaction;
}

test("shutdown releases the first runtime while another session remains active", async (t) => {
	if (!globalThis.gc) {
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		const child = spawnSync(process.execPath, [
			"--expose-gc", "--test", "--test-name-pattern=^" + t.name + "$", __filename,
		], { env, encoding: "utf8", timeout: 30_000 });
		assert.equal(child.status, 0, child.error?.message ?? child.stdout + child.stderr);
		return;
	}
	async function releaseFirst() {
		// Do not register cleanup hooks that would themselves retain the runner.
		const first = await start(null, [TAPE, CUSTOM]);
		const second = await start(null, [TAPE, CUSTOM]);
		const ref = new WeakRef(first.runner);
		await first.stop();
		return { ref, second };
	}
	const { ref, second } = await releaseFirst();
	try {
		for (let i = 0; i < 8; i++) {
			await new Promise((resolve) => setImmediate(resolve));
			globalThis.gc();
		}
		assert.equal(ref.deref() === undefined, true, "a live session must not retain a shutdown runner");
	} finally {
		await second.stop();
	}
});

for (const paths of [[TAPE, CUSTOM], [CUSTOM, TAPE]]) {
	test(`compacts projected history once with ${paths[0] === TAPE ? "tape" : "custom"} loaded first`, async (t) => {
		const runtime = await start(t, paths);
		await anchor(runtime);
		const visible = await runtime.runner.emitContext(runtime.session.buildSessionContext().messages);
		assert.doesNotMatch(JSON.stringify(visible), /DISCARDED_HISTORY/);
		const result = await compact(runtime);
		assert.deepEqual(requests.map(({ remote }) => remote).sort(), [false, true]);
		for (const request of requests) {
			assert.doesNotMatch(JSON.stringify(request.body.input), /DISCARDED_HISTORY/);
			assert.match(JSON.stringify(request.body.input), /ANCHOR_CHECKPOINT/);
			assert.match(JSON.stringify(request.body.input), /RECENT_HISTORY/);
		}
		assert.match(JSON.stringify(requests.find(({ remote }) => remote).body.input), /KEPT_TAIL/);
		assert.deepEqual(result.details.remoteCompaction.replacementHistory.at(-1), artifact);
	});
}

test("tape without custom still produces a portable summary", async (t) => {
	const runtime = await start(t, [TAPE]);
	await anchor(runtime);
	const result = await compact(runtime);
	assert.deepEqual(requests.map(({ remote }) => remote), [false]);
	assert.equal(result.details.remoteCompaction, undefined);
});

test("remote failure preserves the text summary and reports the failure", async (t) => {
	const runtime = await start(t, [CUSTOM, TAPE]);
	await anchor(runtime);
	rejectRemote = true;
	t.after(() => { rejectRemote = false; });
	const result = await compact(runtime);
	assert.deepEqual(requests.map(({ remote }) => remote).sort(), [false, true]);
	assert.equal(result.details.remoteCompaction, undefined);
	assert.match(result.details.remoteCompactionError.message, /remote rejected/);
});

for (const reason of ["manual", "overflow"]) {
	test(`${reason} compaction honors the text-only recovery policy`, async (t) => {
		const runtime = await start(t, [TAPE, CUSTOM], { enabled: reason !== "manual" });
		await anchor(runtime);
		const result = await compact(runtime, reason);
		assert.deepEqual(requests.map(({ remote }) => remote), [false]);
		assert.equal(result.details.remoteCompaction, undefined);
	});
}

test("coexisting sessions keep their compaction preference and thinking level", async (t) => {
	const first = await start(t, [TAPE, CUSTOM], { thinking: "high" });
	await anchor(first);
	const second = await start(t, [CUSTOM, TAPE], { enabled: false, thinking: "low" });
	await anchor(second);

	const firstResult = await compact(first);
	assert.ok(firstResult.details.remoteCompaction, "second session must not disable the first session's remote compaction");
	assert.equal(requests.find(({ remote }) => remote)?.body.reasoning.effort, "high");
	await compact(second);
	assert.deepEqual(requests.map(({ remote }) => remote), [false]);
	await second.stop();
	const remaining = await compact(first);
	assert.ok(remaining.details.remoteCompaction, "shutting down another session must not remove this session's adapter");
});

test("reload uses fresh preferences and removing custom leaves no stale adapter", async (t) => {
	const old = await start(t, [TAPE, CUSTOM], { enabled: false });
	await anchor(old);
	await old.stop("reload");
	loader.clearExtensionCache();
	const replacement = await start(t, [CUSTOM, TAPE], { session: old.session, reason: "reload" });
	assert.ok((await compact(replacement)).details.remoteCompaction);
	await replacement.stop("reload");
	loader.clearExtensionCache();
	let authCalls = 0;
	const tapeOnly = await start(t, [TAPE], {
		session: old.session, reason: "reload",
		authenticate: async () => { authCalls++; return auth; },
	});
	const result = await compact(tapeOnly);
	assert.equal(authCalls, 1, "a removed adapter must not resolve credentials before text fallback");
	assert.deepEqual(requests.map(({ remote }) => remote), [false]);
	assert.equal(result.details.remoteCompaction, undefined);
});

test("a new anchor supersedes the previous remote artifact during replay", async (t) => {
	const runtime = await start(t, [CUSTOM, TAPE]);
	await anchor(runtime);
	const result = await compact(runtime);
	runtime.session.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true, result.usage);
	runtime.session.appendMessage(user("FOLLOW_UP"));
	const payload = { model: model.id, input: [{ role: "user", content: "ACTIVE_PROJECTED_CONTEXT" }] };
	const replayed = await runtime.runner.emitBeforeProviderRequest(payload);
	assert.ok(replayed.input.some((item) => item.type === "compaction"));
	assert.match(JSON.stringify(replayed.input), /FOLLOW_UP/);
	assert.doesNotMatch(JSON.stringify(replayed.input), /DISCARDED_HISTORY/);

	await anchor(runtime, "next-checkpoint");
	assert.deepEqual(await runtime.runner.emitBeforeProviderRequest(payload), payload,
		"an older artifact must not overwrite the new anchor's projected payload");
});

test("adapter setup failure falls back to tape's text compaction", async (t) => {
	let authCalls = 0;
	const runtime = await start(t, [TAPE, CUSTOM], {
		authenticate: async () => ++authCalls === 1 ? { ok: true, apiKey: "invalid-jwt" } : auth,
	});
	await anchor(runtime);
	const result = await compact(runtime);
	assert.deepEqual(requests.map(({ remote }) => remote), [false]);
	assert.equal(result.details.remoteCompaction, undefined);
	assert.doesNotMatch(JSON.stringify(requests[0].body.input), /DISCARDED_HISTORY/);
});

test("split-turn remote compaction retains the request and its tool work", async (t) => {
	const runtime = await start(t, [TAPE, CUSTOM]);
	await anchor(runtime);
	runtime.session.appendMessage(user("SPLIT_REQUEST " + "request ".repeat(1000)));
	runtime.session.appendMessage(assistant([{ type: "toolCall", id: "call_split", name: "read", arguments: { path: "README.md" } }]));
	runtime.session.appendMessage({ role: "toolResult", toolCallId: "call_split", toolName: "read", content: [{ type: "text", text: "SPLIT_TOOL_RESULT " + "result ".repeat(1000) }], isError: false, timestamp: Date.now() });
	runtime.session.appendMessage(assistant([{ type: "text", text: "SPLIT_TAIL" }]));
	await compact(runtime);
	assert.equal(requests.filter(({ remote }) => !remote).length, 2, "the fixture must exercise split-turn summarization");
	const remote = requests.find(({ remote }) => remote);
	assert.ok(JSON.stringify(remote.body.input).includes("SPLIT_REQUEST"), "split request must reach the remote compactor");
	assert.ok(JSON.stringify(remote.body.input).includes("SPLIT_TOOL_RESULT"), "tool work in the prefix must reach the remote compactor");
	assert.ok(JSON.stringify(remote.body.input).includes("SPLIT_TAIL"));
});

test("an old runtime shutdown does not unregister a replacement on the same session manager", async (t) => {
	const old = await start(t, [TAPE, CUSTOM], { enabled: false });
	await anchor(old);
	const replacement = await start(t, [CUSTOM, TAPE], { session: old.session, reason: "reload" });
	await old.stop("reload");
	assert.ok((await compact(replacement)).details.remoteCompaction, "replacement adapter must survive the previous generation's shutdown");
});
