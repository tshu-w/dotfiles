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
			"@earendil-works/pi-ai/compat": `${PI_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
			"@earendil-works/pi-tui": `${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`,
			typebox: `${PI_PACKAGE}/node_modules/typebox/build/index.mjs`,
		},
	});
	const { SessionManager } = await import(`${PI_PACKAGE}/dist/index.js`);
	const factory = (await jiti.import("../index.ts")).default;
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	factory({
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		getThinkingLevel() { return "high"; },
		getActiveTools() { return ["read", "bash", "agent", "web_search", "web_fetch"]; },
		appendEntry() {},
		sendMessage() {},
	});

	assert.deepEqual([...tools], [["agent", tools.get("agent")]]);
	assert.ok(commands.has("agents"));
	const callArgs = { action: "spawn", message: "inspect renderer", context: "fresh", cwd: "/tmp/project" };
	const callStyles = [];
	const callTheme = {
		bold: (text) => `<b>${text}</b>`,
		fg: (color, text) => { callStyles.push([color, text]); return text; },
	};
	const renderedCall = tools.get("agent").renderCall(callArgs, callTheme, { expanded: false });
	assert.deepEqual(renderedCall.render(1000).map((line) => line.trimEnd()), [
		'<b>agent</b>(action="spawn", message="inspect renderer", context="fresh", cwd="/tmp/project")',
		"",
	]);
	assert.equal(callStyles[0][0], "toolTitle");
	assert.equal(callStyles.filter(([color]) => color === "text").length, Object.keys(callArgs).length);
	assert.ok(callStyles.filter(([color]) => color === "muted").length > Object.keys(callArgs).length);
	assert.equal(callStyles.some(([color]) => color === "accent"), false);
	const sessionManager = SessionManager.inMemory("/tmp/pi-swarm-index-test");
	sessionManager.appendCustomEntry("pi-swarm-usage", {
		version: 1,
		usage: { input: 1200, output: 45, cacheRead: 300, cacheWrite: 20, cost: 0.1234, turns: 2 },
	});
	let notification = "";
	const ctx = {
		cwd: "/tmp/pi-swarm-index-test",
		mode: "print",
		hasUI: false,
		model: { provider: "openai-codex", id: "gpt-test" },
		sessionManager,
		isProjectTrusted: () => true,
		ui: { notify(text) { notification = text; } },
	};
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "new" }, ctx);

	const empty = await tools.get("agent").execute("t1", { action: "wait", timeout: 0 }, undefined, undefined, ctx);
	assert.deepEqual(empty.details, { results: [], pending: [], timed_out: false });
	await assert.rejects(
		tools.get("agent").execute("t2", { action: "send", id: "indirect", message: "continue" }, undefined, undefined, ctx),
		/direct child/,
	);
	await assert.rejects(
		tools.get("agent").execute("t3", { action: "wait", message: "not valid" }, undefined, undefined, ctx),
		/wait does not accept: message/,
	);
	await commands.get("agents").handler("", ctx);
	assert.match(notification, /Tree usage: 2 turns ↑1.2k ↓45 R300 W20 \$0.1234/);

	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
	console.log("pi-swarm: extension surface passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
