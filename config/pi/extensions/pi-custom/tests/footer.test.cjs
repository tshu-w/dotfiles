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
			"@earendil-works/pi-ai": `${PI_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
			"@earendil-works/pi-tui": `${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`,
		},
	});
	const { registerFooter } = await jiti.import("../index.ts");
	const { visibleWidth } = await jiti.import(`${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`);
	let start;
	let settings = {};
	registerFooter({ on(_event, handler) { start = handler; }, getSettings: () => settings }, {});
	let footer, branchChanged;
	let branchRenders = 0, branchDisposed = false;
	const usage = { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost: { total: 0.1 } };
	const entries = [
		{ type: "message", message: { role: "assistant", usage } },
		{ type: "message", message: { role: "toolResult", usage } },
		{ type: "compaction", usage, details: { remoteCompaction: { usage: { input_tokens: 7, output_tokens: 1 } } } },
		{ type: "branch_summary", usage },
	];
	const statuses = new Map();
	let scans = 0, contextScans = 0, sessionId = "session-a", branch = "main";
	let leafOverride;
	let contextUsage = { percent: 12, contextWindow: 200000 };
	const manager = {
		getEntries() { scans++; return entries.slice(); },
		getSessionId: () => sessionId,
		getLeafId: () => leafOverride ?? `leaf-${entries.length}`,
	};
	const ctx = {
		mode: "tui",
		sessionManager: manager,
		getContextUsage: () => { contextScans++; return contextUsage; },
		modelRegistry: { isUsingOAuth: () => oauth },
		ui: { setFooter(factory) {
			footer = factory({ requestRender() { branchRenders++; } }, { fg: (_color, text) => text }, {
				getExtensionStatuses: () => statuses,
				getGitBranch: () => branch,
				onBranchChange(callback) { branchChanged = callback; return () => { branchDisposed = true; }; },
			});
		} },
	};
	let oauth = false;
	start({}, ctx);
	assert.match(footer.render(100)[0], /↑40 ↓8 R80 W12 \$0\.400/);
	entries.push({ type: "usage", kind: "cache_warm", usage });
	assert.match(footer.render(100)[0], /↑50 ↓10 R100 W15 \$0\.500/);
	entries.push({ type: "usage", kind: "future-operation", usage });
	assert.match(footer.render(100)[0], /↑60 ↓12 R120 W18 \$0\.600/);
	assert.match(footer.render(100)[0], /↑60 ↓12 R120 W18 \$0\.600/, "rendering again must not double-count usage");

	assert.equal(scans, 3, "unchanged frames must not copy entries");
	assert.equal(contextScans, 3, "unchanged frames must not rescan context");
	assert.match(footer.render(100)[0], /\(auto\)/);
	settings = { compaction: { enabled: false } };
	assert.doesNotMatch(footer.render(100)[0], /\(auto\)/);
	settings = { compaction: { enabled: true } };
	assert.match(footer.render(100)[0], /\(auto\)/);
	assert.match(footer.render(100)[0], /CH60\.6% \(main\) 12\.0%\/200k/);
	contextUsage = { percent: 75, contextWindow: 100000 };
	ctx.model = { provider: "anthropic", contextWindow: 100000 };
	branch = "topic";
	branchChanged();
	assert.equal(branchRenders, 1, "git changes request a repaint while idle");
	assert.match(footer.render(100)[0], /\(topic\) 75\.0%\/100k/);
	assert.equal(scans, 3, "context and git updates do not invalidate totals");
	assert.equal(contextScans, 4, "model changes refresh context without rescanning totals");
	leafOverride = "other-leaf";
	footer.render(100);
	assert.equal(scans, 4, "branch navigation invalidates totals");
	sessionId = "session-b";
	footer.render(100);
	assert.equal(scans, 5, "session changes invalidate totals even with the same leaf");
	ctx.sessionManager = { ...manager };
	footer.render(100);
	assert.equal(scans, 6, "manager identity invalidates totals");
	assert.equal(contextScans, 7, "leaf, session, and manager changes also refresh context");
	leafOverride = undefined;
	entries.push({ type: "message", message: { role: "assistant", usage: { input: 100, cacheRead: 0 } } });
	assert.match(footer.render(100)[0], /CH0\.0%/, "cache hit rate uses latest assistant, not totals");
	entries.push({ type: "message", message: { role: "assistant", usage: {} } });
	assert.doesNotMatch(footer.render(100)[0], /CH/, "zero prompt tokens clear latest cache hit rate");
	statuses.set("test", "working");
	assert.equal(footer.render(200).length, 1);
	const narrow = footer.render(20);
	assert.equal(narrow.length, 2);
	assert.equal(narrow[1], "working");
	statuses.set("test", "a very long extension status that needs truncation");
	assert.ok(footer.render(20).every(line => visibleWidth(line) <= 20));
	statuses.delete("test");
	assert.equal(footer.render(20).length, 1, "no empty status line");

	statuses.set("sub-status:usage", "34m 0% · 6d12h 91%");
	for (const [provider, usesOAuth, visible] of [
		["openrouter", false, false],
		["safe-anthropic", false, false],
		["anthropic", false, false],
		["anthropic", true, true],
		["openai-codex", true, true],
		["openai", false, false],
		["openai", true, true],
		["claude-code", false, true],
	]) {
		ctx.model = { provider, contextWindow: 200000 };
		oauth = usesOAuth;
		assert.equal(footer.render(100).join("\n").includes("34m"), visible, `${provider} OAuth=${usesOAuth}`);
	}
	footer.dispose();
	assert.equal(branchDisposed, true, "footer disposal unsubscribes the branch watcher");
	console.log("pi-custom: footer usage/context caching, invalidation, cache hit rate, git branch, auto indicator, narrow statuses, and subscription filtering pass");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
