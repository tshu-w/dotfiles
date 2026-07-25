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
	const [patched] = handlers.get("before_provider_request").map((handler) =>
		handler(
			{ payload: { model: "gpt-5.6", input: [{ stale: true }] } },
			{ hasUI: false, ui, sessionManager: { getBranch: () => branch } },
		),
	);
	assert.ok(patched, "replay injection should patch the payload");
	assert.equal(patched.model, "gpt-5.6");
	assert.equal(patched.input.length, 3);
	assert.deepEqual(patched.input[0], { role: "user", content: [{ type: "input_text", text: "u1" }] });
	assert.deepEqual(patched.input[1], compactionItem);
	assert.equal(patched.input[2].role, "user");
	assert.match(JSON.stringify(patched.input[2]), /after/);

	// A newest compaction without an artifact falls back to the text summary.
	const plain = handlers.get("before_provider_request")[0](
		{ payload: { model: "gpt-5.6", input: [{ stale: true }] } },
		{ hasUI: false, ui, sessionManager: { getBranch: () => [{ type: "compaction", id: "c2", summary: "s" }] } },
	);
	assert.equal(plain, undefined);

	console.log("pi-custom: codex compaction helpers verified");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
