const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

function assistant({ content = [{ type: "text", text: "ok" }], stopReason = "stop" } = {}) {
	return {
		role: "assistant",
		content,
		stopReason,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function main() {
	const jiti = createJiti(__filename, { interopDefault: true });
	const reroll = await jiti.import("../reroll.ts");
	const { isContextOverflow, isRetryableAssistantError } = await import(
		join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/index.js")
	);

	assert.equal(reroll.requestMaxTokens({ max_tokens: 4096 }), 4096);
	assert.equal(reroll.requestMaxTokens({ max_completion_tokens: 2048 }), 2048);
	assert.equal(reroll.requestMaxTokens({ max_output_tokens: 1024 }), 1024);
	assert.equal(reroll.requestMaxTokens({}), undefined);
	assert.equal(reroll.outputWasClamped({ max_output_tokens: 4096 }, 8192), true);
	assert.equal(reroll.outputWasClamped({ max_output_tokens: 8192 }, 8192), false);

	const length = reroll.classifyAssistantMessage(
		assistant({ content: [{ type: "text", text: "partial" }], stopReason: "length" }),
		true,
		0,
	);
	assert.equal(length.message.stopReason, "error");
	assert.match(length.message.errorMessage, /^context_length_exceeded:/);
	assert.equal(isContextOverflow(length.message, 8192), true);

	const toolCall = assistant({
		content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }],
		stopReason: "length",
	});
	const preserved = reroll.classifyAssistantMessage(toolCall, true, 2);
	assert.equal(preserved.message, toolCall);
	assert.equal(preserved.emptyRerolls, 0);

	const thinkingOnly = assistant({ content: [{ type: "thinking", thinking: "private" }] });
	let rerolls = 0;
	for (let attempt = 1; attempt <= reroll.MAX_EMPTY_REROLLS; attempt++) {
		const result = reroll.classifyAssistantMessage(thinkingOnly, false, rerolls);
		assert.equal(result.message.stopReason, "error");
		assert.match(result.message.errorMessage, /stream ended before a terminal response event/);
		assert.equal(isRetryableAssistantError(result.message), true);
		rerolls = result.emptyRerolls;
	}
	const exhausted = reroll.classifyAssistantMessage(thinkingOnly, false, rerolls);
	assert.equal(exhausted.message, thinkingOnly);

	const clampedEmpty = reroll.classifyAssistantMessage(thinkingOnly, true, 2);
	assert.equal(clampedEmpty.message.stopReason, "error");
	assert.match(clampedEmpty.message.errorMessage, /^context_length_exceeded:/);
	assert.equal(isContextOverflow(clampedEmpty.message, 8192), true);
	assert.equal(clampedEmpty.emptyRerolls, 0);

	const handlers = new Map();
	reroll.registerReroll({
		on(event, handler) { handlers.set(event, handler); },
	});
	const ctx = { model: { maxTokens: 8192 } };
	handlers.get("before_provider_request")({ payload: { max_output_tokens: 4096 } }, ctx);
	const recovered = handlers.get("message_end")({
		message: assistant({ content: [], stopReason: "length" }),
	});
	assert.equal(recovered.message.stopReason, "error");
	assert.match(recovered.message.errorMessage, /^context_length_exceeded:/);

	handlers.get("message_end")({ message: { role: "user", content: "next" } });
	const rerolled = handlers.get("message_end")({ message: thinkingOnly });
	assert.equal(rerolled.message.stopReason, "error");

	console.log("pi-custom: reroll verified");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
