const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

async function main() {
	const jiti = createJiti(__filename, {
		interopDefault: true,
		alias: {
			"@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js`,
		},
	});
	const codex = await jiti.import("../codex.ts");

	// Endpoint resolution mirrors the built-in transport.
	assert.equal(codex.resolveCodexUrl(undefined), "https://chatgpt.com/backend-api/codex/responses");
	assert.equal(codex.resolveCodexUrl("https://x.test/codex"), "https://x.test/codex/responses");
	assert.equal(codex.resolveCodexUrl("https://x.test/codex/responses/"), "https://x.test/codex/responses");

	// Beta-feature header merging keeps configured features.
	assert.equal(codex.withCompactionFeature(null), "remote_compaction_v2");
	assert.equal(codex.withCompactionFeature("a, remote_compaction_v2"), "a,remote_compaction_v2");

	// Retained user messages: newest kept in order, oldest truncated to budget.
	const user = (text) => ({ role: "user", content: [{ type: "input_text", text }] });
	const retained = codex.retainUserMessages(
		[
			user("x".repeat(400)),
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
			{ role: "user", content: [] },
			user("old"),
			user("new"),
		],
		2,
	);
	assert.deepEqual(retained, [
		{ role: "user", content: [{ type: "input_text", text: "old" }] },
		{ role: "user", content: [{ type: "input_text", text: "new" }] },
	]);
	const truncated = codex.retainUserMessages([user("x".repeat(400)), user("tail")], 2);
	assert.deepEqual(truncated.map((item) => item.content[0].text), ["x".repeat(4), "tail"]);

	// Stream parsing: exactly one compaction item plus completion is required.
	const compactionItem = { type: "compaction", encrypted_content: "blob" };
	const result = codex.extractCompactionResult([
		{ type: "response.output_item.done", item: { type: "message" } },
		{ type: "response.output_item.done", item: compactionItem },
		{ type: "response.completed", response: { usage: { input_tokens: 7 } } },
	]);
	assert.deepEqual(result, { item: compactionItem, usage: { input_tokens: 7 } });
	assert.throws(
		() => codex.extractCompactionResult([{ type: "response.completed", response: {} }]),
		/exactly one compaction item/,
	);
	assert.throws(
		() => codex.extractCompactionResult([{ type: "response.output_item.done", item: compactionItem }]),
		/before completion/,
	);
	assert.throws(
		() => codex.extractCompactionResult([
			{ type: "response.output_item.done", item: compactionItem },
			{ type: "response.incomplete", response: {} },
		]),
		/before completion/,
	);
	assert.throws(
		() => codex.extractCompactionResult([{ type: "error", message: "nope" }]),
		/nope/,
	);

	// Replay injection: replacement history plus messages after the compaction
	// entry, converted through the real pi-ai message conversion.
	const handlers = new Map();
	const pi = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getActiveTools: () => [],
		getAllTools: () => [],
		getThinkingLevel: () => "high",
	};
	const model = { provider: "openai-codex", id: "gpt-5.6", api: "openai-codex-responses", compat: {}, input: ["text", "image"], output: ["text"] };
	await codex.registerCodex(pi, {}, { fast: false, compaction: true });
	const ui = { setStatus() {}, notify() {} };
	for (const handler of handlers.get("session_start")) {
		handler({ reason: "new" }, { model, ui, sessionManager: { getBranch: () => [] } });
	}
	const branch = [
		{
			type: "compaction",
			id: "c1",
			summary: "text summary",
			details: {
				remoteCompaction: {
					provider: "openai-codex-responses",
					modelKey: "openai-codex/gpt-5.6",
					replacementHistory: [
						{ role: "user", content: [{ type: "input_text", text: "u1" }] },
						compactionItem,
					],
				},
			},
		},
		{ type: "message", id: "m1", message: { role: "user", content: "after", timestamp: 1 } },
	];
	const [patched] = await Promise.all(handlers.get("before_provider_request").map((handler) =>
		handler(
			{ payload: { model: "gpt-5.6", input: [{ stale: true }] } },
			{ hasUI: false, ui, sessionManager: { getBranch: () => branch } },
		),
	));
	assert.ok(patched, "replay injection should patch the payload");
	assert.equal(patched.model, "gpt-5.6");
	assert.equal(patched.input.length, 3);
	assert.deepEqual(patched.input[0], { role: "user", content: [{ type: "input_text", text: "u1" }] });
	assert.deepEqual(patched.input[1], compactionItem);
	assert.equal(patched.input[2].role, "user");
	assert.match(JSON.stringify(patched.input[2]), /after/);

	// A newest compaction without an artifact falls back to the text summary.
	const plain = await handlers.get("before_provider_request")[0](
		{ payload: { model: "gpt-5.6", input: [{ stale: true }] } },
		{ hasUI: false, ui, sessionManager: { getBranch: () => [{ type: "compaction", id: "c2", summary: "s" }] } },
	);
	assert.equal(plain, undefined);

	// After a text-only compaction, the next remote attempt must use Pi's
	// active context instead of resurrecting every message in the branch.
	const accountPayload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "acct" },
	})).toString("base64url");
	const originalFetch = global.fetch;
	let remoteBody;
	global.fetch = async (url, options) => {
		if (String(url) !== "https://x.test/codex/responses") throw new Error(`unexpected fetch: ${url}`);
		remoteBody = JSON.parse(options.body);
		const sse = [
			`data: ${JSON.stringify({ type: "response.output_item.done", item: compactionItem })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: {} })}`,
			"data: [DONE]",
		].join("\n\n");
		return new Response(sse, { status: 200 });
	};
	try {
		const aborted = AbortSignal.abort();
		const activeMessage = { role: "user", content: "active only", timestamp: 2 };
		const compactedBranch = [
			{ type: "message", id: "old", message: { role: "user", content: "stale history", timestamp: 1 } },
			{ type: "compaction", id: "text-only", summary: "text summary" },
			{ type: "message", id: "active", message: activeMessage },
		];
		await handlers.get("session_before_compact")[0](
			{
				branchEntries: compactedBranch,
				preparation: {
					firstKeptEntryId: "active",
					messagesToSummarize: [activeMessage],
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore: 10,
					fileOps: {},
					settings: { reserveTokens: 1024, keepRecentTokens: 1024 },
				},
				signal: aborted,
			},
			{
				model: { ...model, baseUrl: "https://x.test" },
				hasUI: false,
				ui,
				getSystemPrompt: () => "system",
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `e30.${accountPayload}.sig` }),
				},
				sessionManager: {
					getSessionId: () => "session",
					buildSessionContext: () => ({ messages: [activeMessage] }),
				},
			},
		);
		assert.equal(remoteBody.input.length, 2, "active message plus compaction trigger");
		assert.match(JSON.stringify(remoteBody.input[0]), /active only/);
		assert.doesNotMatch(JSON.stringify(remoteBody.input), /stale history/);

		// The trigger itself consumes one Responses input slot. Skip the remote
		// request when active history would cross the 16,384-item API limit.
		remoteBody = undefined;
		let limitWarning;
		global.fetch = async (_url, options) => {
			const body = JSON.parse(options.body);
			if (body.input?.at(-1)?.type === "compaction_trigger") remoteBody = body;
			return new Response("local compaction disabled in test", { status: 500 });
		};
		const oversizedMessages = Array.from({ length: 16_384 }, (_, index) => index % 2 === 0
			? { role: "user", content: `user ${index}`, timestamp: index }
			: {
				role: "assistant",
				content: [{ type: "text", text: `assistant ${index}` }],
				provider: "openai-codex",
				model: "gpt-5.6",
				stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
				timestamp: index,
			});
		await handlers.get("session_before_compact")[0](
			{
				branchEntries: [{ type: "compaction", id: "text-only", summary: "text summary" }],
				preparation: {
					firstKeptEntryId: "active",
					messagesToSummarize: [activeMessage],
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore: 10,
					fileOps: {},
					settings: { reserveTokens: 1024, keepRecentTokens: 1024 },
				},
				signal: new AbortController().signal,
			},
			{
				model: { ...model, baseUrl: "https://x.test" },
				hasUI: true,
				ui: { ...ui, notify: (message) => { limitWarning = message; } },
				getSystemPrompt: () => "system",
				modelRegistry: {
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `e30.${accountPayload}.sig` }),
				},
				sessionManager: {
					getSessionId: () => "session",
					buildSessionContext: () => ({ messages: oversizedMessages }),
				},
			},
		);
		assert.equal(remoteBody, undefined, "oversized input must not reach fetch");
		assert.match(limitWarning, /16385 items; maximum is 16384/);
	} finally {
		global.fetch = originalFetch;
	}

	console.log("pi-custom: codex compaction helpers verified");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
