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
	const clamped = await jiti.import("../clamped-output.ts");
	const { isContextOverflow, isRecoverableLength, isRetryableAssistantError } = await import(
		join(PI_PACKAGE, "node_modules/@earendil-works/pi-ai/dist/index.js")
	);

	assert.equal(clamped.requestMaxTokens({ max_tokens: 4096 }), 4096);
	assert.equal(clamped.requestMaxTokens({ max_completion_tokens: 2048 }), 2048);
	assert.equal(clamped.requestMaxTokens({ max_output_tokens: 1024 }), 1024);
	assert.equal(clamped.requestMaxTokens({}), undefined);
	assert.equal(clamped.outputWasClamped({ max_output_tokens: 4096 }, 8192), true);
	assert.equal(clamped.outputWasClamped({ max_output_tokens: 8192 }, 8192), false);

	// A length stop under a clamped budget is left to Pi, which compacts and retries it.
	const partial = assistant({ content: [{ type: "text", text: "partial" }], stopReason: "length" });
	assert.equal(clamped.classifyAssistantMessage(partial, true), partial);
	assert.equal(isRecoverableLength(partial, 8192), true);

	const toolCall = assistant({
		content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }],
		stopReason: "length",
	});
	const preserved = clamped.classifyAssistantMessage(toolCall, true);
	assert.equal(preserved, toolCall);

	const thinkingOnly = assistant({ content: [{ type: "thinking", thinking: "private" }] });
	for (const message of [thinkingOnly, assistant({ content: [] }), assistant({ content: [{ type: "text", text: " " }] })]) {
		const result = clamped.classifyAssistantMessage(message, false);
		assert.equal(result, message);
		assert.equal(isRetryableAssistantError(result), false);
	}

	const clampedEmpty = clamped.classifyAssistantMessage(thinkingOnly, true);
	assert.equal(clampedEmpty.stopReason, "error");
	assert.match(clampedEmpty.errorMessage, /^context_length_exceeded:/);
	assert.equal(isContextOverflow(clampedEmpty, 8192), true);

	const handlers = new Map();
	clamped.registerClampedOutput({
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
	assert.equal(handlers.get("message_end")({ message: thinkingOnly }), undefined);
	assert.equal(handlers.get("message_end")({ message: assistant({ content: [] }) }), undefined);

	const failed = { ...assistant(), stopReason: "error", errorMessage: "503 service unavailable" };
	assert.equal(clamped.classifyAssistantMessage(failed, false), failed);
	assert.equal(isRetryableAssistantError(failed), true);

	console.log("pi-custom: clamped output verified");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
