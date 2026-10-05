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
	const { TopBorderEditor } = await jiti.import("../index.ts");
	const { CustomEditor } = await import(`${PI_PACKAGE}/dist/modes/interactive/components/custom-editor.js`);
	const { StatusIndicator } = await import(`${PI_PACKAGE}/dist/modes/interactive/components/status-indicator.js`);
	const { visibleWidth } = await import(`${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`);
	const tui = { requestRender() {}, terminal: { rows: 24 } };
	const theme = { borderColor: (text) => text, selectList: {} };
	const kb = { matches: () => false };
	const ctx = {
		cwd: "/tmp/project",
		model: { provider: "openai", id: "gpt-6-astra" },
		ui: { theme: { fg: (_color, text) => text } },
		sessionManager: { getSessionName: () => "Session" },
	};
	const editor = new TopBorderEditor({}, ctx, {}, tui, theme, kb);
	const native = new CustomEditor(tui, theme, kb, { embedWorkingStatus: true });
	assert.equal(editor.embedWorkingStatus, true);
	assert.match(editor.render(80)[0], /project — Session/);
	const statuses = [
		["working", "Working"],
		["compaction", "Compacting 上下文…"],
		["retry", "Retrying (2/3) in 10s... (esc to cancel)"],
	].map(([kind, message]) => new StatusIndicator(kind, tui, (s) => s, (s) => `\u001b[33m${s}\u001b[0m`, message, { frames: ["*"] }));
	const indicator = statuses[0];
	for (const status of [...statuses, undefined]) {
		editor.setWorkingStatusIndicator(status);
		native.setWorkingStatusIndicator(status);
		const wide = editor.render(100)[0];
		assert.match(wide, /openai\/gpt-6-astra/);
		if (status) {
			assert.ok(wide.includes(status.renderInBorder(100)));
			assert.doesNotMatch(wide, /project|Session/);
		}
		for (const width of [0, 1, 4, 7, 8, 16, 30, 80]) {
			assert.equal(editor.renderTopBorder(width, 5), native.renderTopBorder(width, 5));
			assert.ok(visibleWidth(editor.renderTopBorder(width, 0)) <= width);
		}
		if (status) {
			assert.match(editor.renderTopBorder(8, 0), /\*/);
			assert.doesNotMatch(editor.renderTopBorder(8, 0), /Working|Compacting|Retrying|openai/);
		}
		if (status === indicator) {
			assert.match(editor.renderTopBorder(18, 0), /Working/);
			assert.doesNotMatch(editor.renderTopBorder(18, 0), /openai/);
		}
	}
	assert.match(editor.render(80)[0], /project — Session/);
	console.log("pi-custom: editor keeps models beside status, prioritizes status at narrow widths, and preserves hidden-line borders");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
