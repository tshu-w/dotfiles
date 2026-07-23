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
	const appended = [];
	return {
		handlers,
		commands,
		appended,
		pi: {
			appendEntry(customType, data) { appended.push({ customType, data }); },
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
	const piAgent = await jiti.import("@earendil-works/pi-coding-agent");
	piAgent.initTheme("dark");
	const extension = await jiti.import("../index.ts");
	const factory = extension.default;
	const calls = [];
	let closed = false;
	const panel = new extension.PreferencesPanel(
		{ fg: (role, text) => role === "dim" ? `<dim>${text}</dim>` : text },
		{
			get: () => ({
				fast: { value: false, scope: "global" },
				transcriptOptimization: { value: true, scope: "global" },
			}),
			getHistoryStatus: () => "Recent",
			toggleSession: (field) => calls.push(`toggle:${field}`),
			saveGlobal: (field) => calls.push(`global:${field}`),
			resetSession: (field) => calls.push(`reset:${field}`),
			showOlderHistory: () => calls.push("history:older"),
			showRecentHistory: () => calls.push("history:recent"),
			showFullHistory: () => calls.push("history:full"),
		},
		() => {},
		() => { closed = true; },
	);
	assert.match(panel.render(80).join("\n"), /Use OpenAI priority service tier/);
	assert.match(panel.render(80).join("\n"), /g save global · r reset/);
	assert.match(panel.render(80).join("\n"), /Off     <dim>\[global\]<\/dim>/);
	panel.handleInput(" ");
	panel.handleInput("g");
	panel.handleInput("\x1b[B");
	assert.match(panel.render(80).join("\n"), /Optimize long transcript rendering/);
	panel.handleInput("\r");
	panel.handleInput("r");
	panel.handleInput("\x1b[B");
	assert.match(panel.render(80).join("\n"), /Load older compaction intervals/);
	assert.match(panel.render(80).join("\n"), /Enter\/Space load older · r recent · f full/);
	panel.handleInput("\r");
	panel.handleInput("f");
	panel.handleInput("r");
	panel.handleInput("\x1b");
	assert.deepEqual(calls, [
		"toggle:fast",
		"global:fast",
		"toggle:transcriptOptimization",
		"reset:transcriptOptimization",
		"history:older",
		"history:full",
		"history:recent",
	]);
	assert.equal(closed, true);

	const first = extensionHarness();
	const second = extensionHarness();
	factory(first.pi);
	factory(second.pi);

	const firstCtx = context("openai-codex");
	const secondCtx = context("anthropic");
	await emit(first, "session_start", { reason: "new" }, firstCtx);
	assert.equal(first.commands.has("fast"), false);
	assert.equal(first.commands.has("custom"), false);
	await first.commands.get("preferences").handler("", {
		...firstCtx,
		mode: "tui",
		ui: {
			...firstCtx.ui,
			custom: async (create) => {
				const settingsPanel = create(
					{ requestRender() {} },
					{ fg: (_role, text) => text, bold: (text) => text },
					{},
					() => {},
				);
				settingsPanel.handleInput(" ");
			},
		},
	});
	assert.deepEqual(first.appended.at(-1), {
		customType: "pi-custom:settings",
		data: { fast: true },
	});
	await emit(second, "session_start", { reason: "new" }, secondCtx);

	const firstResults = await emit(first, "before_provider_request", { payload: { model: "x" } }, firstCtx);
	const secondResults = await emit(second, "before_provider_request", { payload: { model: "x" } }, secondCtx);
	assert.deepEqual(firstResults.filter(Boolean), [{ model: "x", service_tier: "priority" }]);
	assert.deepEqual(secondResults.filter(Boolean), []);

	console.log("pi-custom: scoped settings UI and session state verified");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
