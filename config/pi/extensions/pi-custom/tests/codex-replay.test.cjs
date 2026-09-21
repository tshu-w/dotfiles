// Real Pi loader, runner, session checkpoint and provider conversion; HTTP is offline.
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { zstdDecompressSync } = require("node:zlib");

const prefix = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const pkg = join(prefix, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-replay-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const account = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64url");
const apiKey = `e30.${account}.sig`;
const artifact = { type: "compaction", encrypted_content: "offline-artifact" };
const read = { name: "read", description: "Read", parameters: { type: "object", properties: {} } };
const extra = { name: "review_extra", description: "Extra", parameters: { type: "object", properties: {} } };
let core, loader, streamSimple, models, ai;
let requests = [];
let expectedUrl = "https://codex.test/codex/responses";
let localMode = "success", remoteMode = "success";

before(async () => {
	core = await import(pathToFileURL(join(pkg, "dist/index.js")).href);
	loader = await import(pathToFileURL(join(pkg, "dist/core/extensions/loader.js")).href);
	ai = await import(pathToFileURL(join(pkg, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
	({ streamSimple } = await import(pathToFileURL(join(pkg, "node_modules/@earendil-works/pi-ai/dist/compat.js")).href));
	({ OPENAI_CODEX_MODELS: models } = await import(pathToFileURL(join(pkg, "node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.models.js")).href));
	globalThis.WebSocket = undefined;
	globalThis.fetch = async (url, options) => {
		assert.equal(String(url), expectedUrl);
		const body = JSON.parse(new Headers(options.headers).get("content-encoding") === "zstd"
			? zstdDecompressSync(options.body).toString("utf8") : options.body);
		const remote = body.input.at(-1)?.type === "compaction_trigger";
		requests.push({ body, remote, url: String(url), headers: new Headers(options.headers), signal: options.signal });
		const mode = remote ? remoteMode : localMode;
		if (mode === "fail") return new Response('data: {"type":"response.failed","response":{"error":{"message":"offline rejection"}}}\n\n');
		const usage = mode === "missing" ? undefined : {
			input_tokens: remote ? 70 : 10, output_tokens: remote ? 7 : 1, total_tokens: remote ? 77 : 11,
			input_tokens_details: { cached_tokens: remote ? 20 : 2, cache_write_tokens: remote ? 5 : 1 },
			output_tokens_details: { reasoning_tokens: remote ? 2 : 1 },
		};
		const item = remote ? artifact : {
			type: "message", id: "msg_test", role: "assistant", status: "completed",
			content: [{ type: "output_text", text: "Portable summary.", annotations: [] }],
		};
		return new Response([
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage } },
		].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	};
});
after(() => {
	globalThis.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
});

async function start(t, modelId = "gpt-5.6-sol", createRegistry) {
	requests = [];
	expectedUrl = "https://codex.test/codex/responses";
	localMode = remoteMode = "success";
	const model = { ...models[modelId], baseUrl: "https://codex.test", cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } };
	const session = core.SessionManager.inMemory(agentDir);
	const loaded = await loader.loadExtensions([join(__dirname, "../index.ts")], agentDir);
	assert.deepEqual(loaded.errors, []);
	const registry = createRegistry ? await createRegistry(model) : {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey }),
		streamSimple: (...args) => streamSimple(...args),
		registerProvider() {}, unregisterProvider() {},
	};
	const runner = new core.ExtensionRunner(loaded.extensions, loaded.runtime, agentDir, session, registry);
	const runtime = { model, runner, session, tools: [read] };
	const errors = [];
	runner.onError((error) => errors.push(error));
	runner.setUIContext(undefined, "print");
	runner.bindCore({
		getActiveTools: () => runtime.tools.map((tool) => tool.name),
		getAllTools: () => [read, extra],
		getThinkingLevel: () => "high",
	}, {
		getModel: () => model, getScopedModels: () => [], isIdle: () => true,
		isProjectTrusted: () => true, getSignal: () => undefined, hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 100, contextWindow: model.contextWindow }),
		getSystemPrompt: () => "BASE",
	});
	await runner.emit({ type: "session_start", reason: "startup" });
	t.after(async () => {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		assert.deepEqual(errors, []);
	});
	return runtime;
}

function user(content) {
	return { role: "user", content, timestamp: Date.now() };
}
function checkpoint(runtime) {
	const { session, model } = runtime;
	session.appendMessage({ role: "system", content: "BASE", toolsAdded: [read], timestamp: 1 });
	const first = session.appendMessage(user("old history"));
	session.appendCompaction("summary", first, 100, { remoteCompaction: {
		provider: "openai-codex-responses", modelKey: `${model.provider}/${model.id}`,
		replacementHistory: [artifact],
	} }, true);
}
async function payload(runtime, replay) {
	let body;
	const result = await streamSimple(runtime.model, { messages: core.convertToLlm(runtime.session.buildSessionContext().messages) }, {
		apiKey, transport: "sse",
		onPayload: async (input) => {
			body = replay ? await runtime.runner.emitBeforeProviderRequest(input) : input;
			return body;
		},
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	return body;
}

for (const modelId of ["gpt-5.6-sol", "gpt-5.5"]) {
	for (const immediate of [true, false]) {
		test(`${modelId} replay preserves ${immediate ? "immediate" : "later"} system and tool additions`, async (t) => {
			const runtime = await start(t, modelId);
			checkpoint(runtime);
			if (!immediate) runtime.session.appendMessage(user("before update"));
			runtime.session.appendMessage({ role: "system", content: "SYSTEM_UPDATE_MARKER", sections: { review: "STRUCTURED_UPDATE_MARKER" }, toolsAdded: [extra], timestamp: 2 });
			runtime.session.appendMessage(user("use review_extra"));
			runtime.tools = [read, extra];
			const original = await payload(runtime, false);
			const replayed = await payload(runtime, true);
			const updates = (body) => body.input
				.filter((item) => item.role === "developer" || item.type === "tool_search_call" || item.type === "tool_search_output")
				.map(({ call_id, ...item }) => item);
			const search = replayed.input.filter((item) => item.type === "tool_search_call" || item.type === "tool_search_output");
			if (search.length) assert.equal(search[0].call_id, search[1].call_id);
			assert.ok(updates(original).length >= 2, "exercise native system and dynamic tool conversion");
			assert.deepEqual(updates(replayed), updates(original));
			assert.deepEqual(replayed.tools, original.tools);
			assert.equal(replayed.instructions, original.instructions);
			assert.ok(replayed.input.some((item) => item.type === "compaction"));
		});
	}
}

for (const modelId of ["gpt-5.6-sol", "gpt-5.3-codex-spark"]) {
	test(`${modelId} replay preserves native removal and prompt-collapse behavior`, async (t) => {
		const runtime = await start(t, modelId);
		checkpoint(runtime);
		runtime.session.appendMessage({ role: "system", content: "UPDATED", toolsAdded: [extra], toolsRemoved: [{ name: "read" }], timestamp: 2 });
		runtime.session.appendMessage(user("use review_extra"));
		runtime.tools = [extra];
		const original = await payload(runtime, false), replayed = await payload(runtime, true);
		assert.deepEqual(replayed.tools, original.tools);
		assert.deepEqual(replayed.tools.map((tool) => tool.name), ["review_extra"]);
		assert.equal(replayed.instructions, original.instructions);
		assert.deepEqual(replayed.input.filter((item) => item.role === "developer"), original.input.filter((item) => item.role === "developer"));
	});
}

for (const authBaseUrl of [undefined, "https://auth.test", "https://auth.test/codex/", "https://auth.test/codex/responses///"]) {
	test(`compaction honors native registry routing with auth.baseUrl=${authBaseUrl}`, async (t) => {
		const calls = [];
		const env = { CODEX_REVIEW_ENV: "session-only" };
		const originalEnv = process.env.CODEX_REVIEW_ENV;
		const runtime = await start(t, "gpt-5.6-sol", async (model) => {
			model.headers = { "x-model": "model-header" };
			const modelRuntime = await core.ModelRuntime.create({
				credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(),
				modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
			});
			const customStream = (requestModel, context, options) => {
				calls.push({ model: requestModel, options });
				return streamSimple(requestModel, context, {
					...options, headers: { ...options.headers, "x-registry-stream": "used" },
				});
			};
			modelRuntime.registerNativeProvider(ai.createProvider({
				id: "openai-codex", baseUrl: model.baseUrl, models: [model],
				auth: { apiKey: { name: "Offline auth", resolve: async () => ({
					auth: { apiKey, baseUrl: authBaseUrl, headers: { "x-resolved-auth": "auth-header" } }, env,
				}) } },
				api: { stream: customStream, streamSimple: customStream },
			}));
			return new core.ModelRegistry(modelRuntime);
		});
		expectedUrl = authBaseUrl ? "https://auth.test/codex/responses" : "https://codex.test/codex/responses";
		const first = runtime.session.appendMessage(user("summarize this history"));
		const signal = new AbortController().signal;
		const result = await runtime.runner.emit({
			type: "session_before_compact", branchEntries: runtime.session.getBranch(), reason: "manual", willRetry: false, signal,
			preparation: {
				firstKeptEntryId: first, messagesToSummarize: runtime.session.buildSessionContext().messages,
				turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { reserveTokens: 1024, keepRecentTokens: 10 },
			},
		});
		assert.equal(calls.length, 1, "text summary must call the registered stream exactly once");
		assert.equal(calls[0].model.baseUrl, authBaseUrl ?? runtime.model.baseUrl);
		assert.equal(calls[0].options.apiKey, apiKey);
		assert.deepEqual(calls[0].options.env, env);
		assert.equal(calls[0].options.signal, signal);
		assert.equal(process.env.CODEX_REVIEW_ENV, originalEnv);
		assert.deepEqual(requests.map(({ remote }) => remote).sort(), [false, true]);
		for (const request of requests) {
			assert.equal(request.url, expectedUrl);
			assert.equal(request.headers.get("authorization"), `Bearer ${apiKey}`);
			assert.equal(request.headers.get("x-model"), "model-header");
			assert.equal(request.headers.get("x-resolved-auth"), "auth-header");
		}
		assert.equal(requests.find(({ remote }) => !remote).headers.get("x-registry-stream"), "used");
		assert.equal(requests.find(({ remote }) => remote).signal, signal);
		assert.equal(result.compaction.summary, "Portable summary.");
		assert.equal(result.compaction.usage.totalTokens, 88);
	});
}

test("compaction matches native null deletion, case-insensitive overrides and mandatory auth headers", async (t) => {
	const runtime = await start(t, "gpt-5.6-sol", (model) => {
		model.headers = { "X-Remove": "old", "X-Override": "old", Authorization: "stale" };
		return {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey, headers: {
				"x-remove": null, "x-missing": null, "x-override": "new",
				authorization: null, "chatgpt-account-id": null,
			} }),
			streamSimple: (...args) => streamSimple(...args),
			registerProvider() {}, unregisterProvider() {},
		};
	});
	const first = runtime.session.appendMessage(user("summarize this history"));
	const result = await runtime.runner.emit({
		type: "session_before_compact", branchEntries: runtime.session.getBranch(), reason: "manual", willRetry: false,
		signal: new AbortController().signal,
		preparation: {
			firstKeptEntryId: first, messagesToSummarize: runtime.session.buildSessionContext().messages,
			turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { reserveTokens: 1024, keepRecentTokens: 10 },
		},
	});
	assert.deepEqual(requests.map(({ remote }) => remote).sort(), [false, true]);
	for (const { headers } of requests) {
		assert.equal(headers.has("X-Remove"), false);
		assert.equal(headers.has("x-missing"), false);
		assert.equal(headers.get("X-Override"), "new");
		assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
		assert.equal(headers.get("chatgpt-account-id"), "offline");
		assert.ok([...headers.values()].every((value) => value !== "null"));
	}
	assert.equal(result.compaction.usage.totalTokens, 88);
});

for (const [local, remote, expected, split = false] of [
	["success", "success", { input: 52, output: 8, cacheRead: 22, cacheWrite: 6, total: 88, reasoning: 3, cost: 158 }],
	["fail", "success", { input: 45, output: 7, cacheRead: 20, cacheWrite: 5, total: 77, reasoning: 2, cost: 139 }],
	["success", "fail", { input: 7, output: 1, cacheRead: 2, cacheWrite: 1, total: 11, reasoning: 1, cost: 19 }],
	["success", "missing", { input: 7, output: 1, cacheRead: 2, cacheWrite: 1, total: 11, reasoning: 1, cost: 19 }],
	["success", "success", { input: 59, output: 9, cacheRead: 24, cacheWrite: 7, total: 99, reasoning: 4, cost: 177 }, true],
]) {
	test(`compaction accounts once with local=${local}, remote=${remote}, split=${split}`, async (t) => {
		const runtime = await start(t);
		localMode = local;
		remoteMode = remote;
		const first = runtime.session.appendMessage(user("summarize this history"));
		const result = await runtime.runner.emit({
			type: "session_before_compact", branchEntries: runtime.session.getBranch(), reason: "manual", willRetry: false,
			signal: new AbortController().signal,
			preparation: {
				firstKeptEntryId: first, messagesToSummarize: runtime.session.buildSessionContext().messages,
				turnPrefixMessages: split ? [user("turn prefix")] : [], isSplitTurn: split, tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { reserveTokens: 1024, keepRecentTokens: 10 },
			},
		});
		assert.deepEqual(requests.map(({ remote }) => remote).sort(), split ? [false, false, true] : [false, true]);
		assert.deepEqual(requests.find(({ remote }) => remote).body.tools.map((tool) => tool.name), ["read"], "remote compaction excludes inactive tools");
		const compacted = result.compaction;
		assert.equal(compacted.usage.totalTokens, expected.total);
		assert.equal(compacted.usage.reasoning, expected.reasoning);
		assert.equal(Math.round(compacted.usage.cost.total * 1e6), expected.cost);
		runtime.session.appendCompaction(compacted.summary, first, 100, compacted.details, true, compacted.usage);
		if (remote === "success") assert.equal(compacted.details.remoteCompaction.usage.total_tokens, 77);
		// Exercise Pi's native aggregation on the actual persisted entries twice.
		const stats = () => core.AgentSession.prototype.getSessionStats.call({
			sessionManager: runtime.session, getContextUsage: () => undefined,
		});
		for (let i = 0; i < 2; i++) {
			assert.deepEqual(stats().tokens, {
				input: expected.input, output: expected.output, cacheRead: expected.cacheRead,
				cacheWrite: expected.cacheWrite, total: expected.total,
			});
			assert.equal(Math.round(stats().cost * 1e6), expected.cost);
		}
	});
}

async function contextEditRegistry(model) {
	const runtime = await core.ModelRuntime.create({
		credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(),
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	runtime.registerNativeProvider(ai.createProvider({
		id: "openai-codex", baseUrl: model.baseUrl, models: [model],
		auth: { apiKey: { name: "Offline", resolve: async () => ({ auth: { apiKey } }) } },
		api: { stream: (...args) => streamSimple(...args), streamSimple: (...args) => streamSimple(...args) },
	}));
	return new core.ModelRegistry(runtime);
}

async function generateArtifact(runtime, firstKeptEntryId) {
	const result = await runtime.runner.emit({
		type: "session_before_compact", branchEntries: runtime.session.getBranch(), reason: "manual", willRetry: false,
		signal: new AbortController().signal,
		preparation: {
			firstKeptEntryId, messagesToSummarize: runtime.session.buildSessionProjection().messages,
			turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { reserveTokens: 1024, keepRecentTokens: 10 },
		},
	});
	const compacted = result.compaction;
	assert.ok(compacted.details.remoteCompaction);
	runtime.session.appendCompaction(compacted.summary, firstKeptEntryId, 100, compacted.details, true, compacted.usage);
	return compacted;
}

function assertContextEdit(input, replacement) {
	assert.doesNotMatch(JSON.stringify(input), /EDIT_OLD_MARKER/);
	if (replacement) assert.match(JSON.stringify(input), /EDIT_NEW_MARKER/);
}

for (const replacement of [null, { content: "EDIT_NEW_MARKER" }]) {
	const kind = replacement ? "replacement" : "omission";
	test(`context edit ${kind} without an artifact leaves native context unchanged`, async (t) => {
		const runtime = await start(t, "gpt-5.6-sol", contextEditRegistry);
		const id = runtime.session.appendMessage(user("EDIT_OLD_MARKER"));
		runtime.session.appendMessage(user("continue"));
		runtime.session.appendContextEdit(id, replacement);
		const original = await payload(runtime, false), replayed = await payload(runtime, true);
		assertContextEdit(replayed.input, replacement);
		assert.deepEqual(replayed.input, original.input);
	});

	test(`context edit ${kind} after an artifact uses projected tail for replay and recompaction`, async (t) => {
		const runtime = await start(t, "gpt-5.6-sol", contextEditRegistry);
		checkpoint(runtime);
		const id = runtime.session.appendMessage(user("EDIT_OLD_MARKER"));
		runtime.session.appendMessage(user("continue"));
		runtime.session.appendContextEdit(id, replacement);
		assertContextEdit(runtime.session.buildSessionProjection().messages, replacement);
		const replayed = await payload(runtime, true);
		assertContextEdit(replayed.input, replacement);
		assert.ok(replayed.input.some((item) => item.type === "compaction"), "tail edits need not invalidate the artifact");
		assert.deepEqual(requests.at(-1).body.input, replayed.input);
		requests = [];
		await generateArtifact(runtime, id);
		for (const request of requests) assertContextEdit(request.body.input, replacement);
	});

	test(`context edit ${kind} before first artifact creation is reflected in its retained users`, async (t) => {
		const runtime = await start(t, "gpt-5.6-sol", contextEditRegistry);
		const id = runtime.session.appendMessage(user("EDIT_OLD_MARKER"));
		runtime.session.appendMessage(user("continue"));
		runtime.session.appendContextEdit(id, replacement);
		await generateArtifact(runtime, id);
		assertContextEdit(requests.find(({ remote }) => remote).body.input, replacement);
		const replayed = await payload(runtime, true);
		assertContextEdit(replayed.input, replacement);
		assert.ok(replayed.input.some((item) => item.type === "compaction"));
	});

	test(`context edit ${kind} of pre-artifact content invalidates cached replay and recompaction`, async (t) => {
		const runtime = await start(t, "gpt-5.6-sol", contextEditRegistry);
		const id = runtime.session.appendMessage(user("EDIT_OLD_MARKER"));
		runtime.session.appendMessage(user("continue"));
		const compacted = await generateArtifact(runtime, id);
		assert.match(JSON.stringify(compacted.details.remoteCompaction.replacementHistory), /EDIT_OLD_MARKER/);
		runtime.session.appendContextEdit(id, replacement);
		const original = await payload(runtime, false), replayed = await payload(runtime, true);
		assertContextEdit(replayed.input, replacement);
		assert.deepEqual(replayed.input, original.input, "invalid artifact must leave the canonical provider payload intact");
		requests = [];
		await generateArtifact(runtime, id);
		for (const request of requests) {
			assertContextEdit(request.body.input, replacement);
			assert.ok(!request.body.input.some((item) => item.type === "compaction"), "never feed the invalid artifact to another compaction");
		}
		const renewed = await payload(runtime, true);
		assertContextEdit(renewed.input, replacement);
		assert.ok(renewed.input.some((item) => item.type === "compaction"), "a freshly generated artifact remains usable");
	});
}

for (const role of ["custom", "assistant"]) {
	test(`context edit replacement preserves projected ${role} tail provenance`, async (t) => {
		const runtime = await start(t, "gpt-5.6-sol", contextEditRegistry);
		checkpoint(runtime);
		const id = role === "custom"
			? runtime.session.appendCustomMessageEntry("review", "EDIT_OLD_MARKER", false)
			: runtime.session.appendMessage({
				role: "assistant", content: [{ type: "text", text: "EDIT_OLD_MARKER" }],
				api: runtime.model.api, provider: runtime.model.provider, model: runtime.model.id,
				stopReason: "stop", timestamp: 1,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
			});
		runtime.session.appendContextEdit(id, { content: "INTERMEDIATE_MARKER" });
		runtime.session.appendContextEdit(id, { content: "EDIT_NEW_MARKER" });
		runtime.session.appendMessage(user("continue"));
		const replayed = await payload(runtime, true);
		assertContextEdit(replayed.input, true);
		assert.doesNotMatch(JSON.stringify(replayed.input), /INTERMEDIATE_MARKER|old history/);
		assert.ok(replayed.input.some((item) => item.type === "compaction"));
		requests = [];
		await generateArtifact(runtime, id);
		for (const request of requests) assertContextEdit(request.body.input, true);
	});
}

test("context edit artifact invalidation is branch-local and leaves stored history intact", async (t) => {
	const runtime = await start(t, "gpt-5.6-sol", contextEditRegistry);
	const id = runtime.session.appendMessage(user("EDIT_OLD_MARKER"));
	const compacted = await generateArtifact(runtime, id);
	const checkpointId = runtime.session.getLeafId();
	const editId = runtime.session.appendContextEdit(id, null);
	assert.ok(!(await payload(runtime, true)).input.some((item) => item.type === "compaction"));
	runtime.session.branch(checkpointId);
	const restored = await payload(runtime, true);
	assert.ok(restored.input.some((item) => item.type === "compaction"));
	assert.match(JSON.stringify(restored.input), /EDIT_OLD_MARKER/);
	runtime.session.branch(editId);
	const edited = await payload(runtime, true);
	assertContextEdit(edited.input, null);
	assert.ok(!edited.input.some((item) => item.type === "compaction"));
	assert.equal(runtime.session.getEntry(id).message.content, "EDIT_OLD_MARKER");
	assert.match(JSON.stringify(compacted.details.remoteCompaction.replacementHistory), /EDIT_OLD_MARKER/);
});

test("context edit of an already summarized source invalidates the artifact without rewriting the text summary", async (t) => {
	const runtime = await start(t, "gpt-5.6-sol", contextEditRegistry);
	const id = runtime.session.appendMessage(user("EDIT_OLD_MARKER"));
	const firstKept = runtime.session.appendMessage(user("kept"));
	const compacted = await generateArtifact(runtime, firstKept);
	runtime.session.appendCompaction("Existing summary mentions EDIT_OLD_MARKER", firstKept, 100, compacted.details, true);
	runtime.session.appendContextEdit(id, null);
	const canonical = await payload(runtime, false), replayed = await payload(runtime, true);
	assert.deepEqual(replayed.input, canonical.input);
	assert.ok(!replayed.input.some((item) => item.type === "compaction"));
	assert.match(JSON.stringify(replayed.input), /Existing summary mentions EDIT_OLD_MARKER/);
});
