const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

function extensionHarness() {
	const handlers = new Map();
	const commands = new Map();
	return {
		handlers,
		commands,
		pi: {
			on(event, handler) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			registerCommand(name, command) { commands.set(name, command); },
			getThinkingLevel() { return "off"; },
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		},
	};
}

function context(provider) {
	return {
		hasUI: false,
		mode: "print",
		cwd: "/tmp/pi-custom-test",
		model: { provider, id: "model" },
		ui: {
			setStatus() {},
			notify() {},
			setEditorComponent() {},
			setFooter() {},
		},
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionName: () => undefined,
		},
	};
}

async function emit(harness, event, payload, ctx) {
	const results = [];
	for (const handler of harness.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
	return results;
}

async function main() {
	const jiti = createJiti(__filename, {
		interopDefault: true,
		alias: {
			"@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js`,
			"@earendil-works/pi-ai/compat": `${PI_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
			"@earendil-works/pi-tui": `${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`,
		},
	});
	const factory = (await jiti.import("../index.ts")).default;
	const first = extensionHarness();
	const second = extensionHarness();
	factory(first.pi);
	factory(second.pi);

	const firstCtx = context("openai-codex");
	const secondCtx = context("anthropic");
	await emit(first, "session_start", { reason: "new" }, firstCtx);
	await first.commands.get("fast").handler("on", firstCtx);
	await emit(second, "session_start", { reason: "new" }, secondCtx);

	const firstResults = await emit(first, "before_provider_request", { payload: { model: "x" } }, firstCtx);
	const secondResults = await emit(second, "before_provider_request", { payload: { model: "x" } }, secondCtx);
	assert.deepEqual(firstResults.filter(Boolean), [{ model: "x", service_tier: "priority" }]);
	assert.deepEqual(secondResults.filter(Boolean), []);

	console.log("pi-custom: extension instances keep independent Fast state");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
