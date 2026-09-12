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
	let start;
	registerFooter({ on(_event, handler) { start = handler; } }, {});
	let footer;
	const usage = { input: 10, output: 2, cacheRead: 20, cacheWrite: 3, cost: { total: 0.1 } };
	const entries = [
		{ type: "message", message: { role: "assistant", usage } },
		{ type: "message", message: { role: "toolResult", usage } },
		{ type: "compaction", usage },
		{ type: "branch_summary", usage },
	];
	start({}, {
		mode: "tui",
		sessionManager: { getEntries: () => entries },
		ui: { setFooter(factory) {
			footer = factory({}, { fg: (_color, text) => text }, { getExtensionStatuses: () => new Map() });
		} },
	});
	assert.match(footer.render(100)[0], /↑40 ↓8 R80 W12 \$0\.400/);
	entries.push({ type: "usage", kind: "cache_warm", usage });
	assert.match(footer.render(100)[0], /↑50 ↓10 R100 W15 \$0\.500/);
	entries.push({ type: "usage", kind: "future-operation", usage });
	assert.match(footer.render(100)[0], /↑60 ↓12 R120 W18 \$0\.600/);
	assert.match(footer.render(100)[0], /↑60 ↓12 R120 W18 \$0\.600/, "rendering again must not double-count usage");
	console.log("pi-custom: footer includes cache warming and other usage entries");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
