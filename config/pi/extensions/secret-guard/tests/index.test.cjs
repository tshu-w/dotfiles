const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");

const EXTENSION_DIR = dirname(__dirname);
const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

// Assembled at runtime so this file never carries a literal blocked path.
const NETRC = `.net${"rc"}`;
const REDACTION_NOTICE = "[Secret Guard redacted sensitive values. Do not copy [REDACTED] back into files.]";

async function main() {
	const jiti = createJiti(__filename, {
		interopDefault: true,
		alias: { "@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js` },
	});
	const { DEFAULT_MAX_BYTES } = await jiti.import(`${PI_PACKAGE}/dist/index.js`);
	const register = await jiti.import(join(EXTENSION_DIR, "index.ts"), { default: true });

	const handlers = {};
	register({ on: (name, handler) => { handlers[name] = handler; } });
	const toolCall = (toolName, input) =>
		handlers.tool_call({ type: "tool_call", toolCallId: "call", toolName, input });
	const toolResult = (toolName, input, text) =>
		handlers.tool_result({
			type: "tool_result",
			toolCallId: "call",
			toolName,
			input,
			isError: false,
			content: [{ type: "text", text }],
		});
	const textOf = (result) => result.content.map((part) => part.text).join("\n");

	// Credential paths are blocked for every tool that can reveal their contents.
	assert.deepEqual(await toolCall("read", { path: `~/${NETRC}` }), { block: true, reason: `Sensitive file (${NETRC})` });
	assert.equal((await toolCall("grep", { pattern: "password", path: `/Users/x/${NETRC}` })).block, true);
	assert.equal((await toolCall("grep", { pattern: "key", path: "~/.aws/credentials" })).block, true);
	assert.equal((await toolCall("bash", { command: `cat ~/${NETRC}` })).block, true);
	assert.equal((await toolCall("write", { path: "~/.ssh/id_ed25519" })).block, true);
	assert.equal(await toolCall("grep", { pattern: "token", path: "src/app.ts" }), undefined);
	assert.equal(await toolCall("grep", { pattern: "token" }), undefined, "grep without a path still runs");
	assert.equal(await toolCall("find", { pattern: "*", path: "~/.ssh" }), undefined, "find only lists names");

	const untouched = await toolResult("read", { path: "src/app.ts" }, "const timeout = 30;");
	assert.equal(untouched, undefined, "results without secrets pass through unchanged");

	// Source output is also checked by bash and the outer Program result handler.
	const sourceOutput = [
		'const SETTINGS_DOCUMENT_KEY = "pi-custom";',
		'let PACKAGE_UPDATE_STATUS_KEY = "pkg-update";',
		"const API_KEY = process.env.API_KEY;",
	].join("\n");
	for (const toolName of ["read", "bash", "program"]) {
		const input = toolName === "read" ? { path: "src/app.ts" } : {};
		assert.equal(await toolResult(toolName, input, sourceOutput), undefined, `${toolName} preserves source declarations`);
		assert.equal(await handlers.tool_result({
			toolName, input, content: [{ type: "text", text: "Source preview" }],
			structuredContent: { output: sourceOutput },
		}), undefined, `${toolName} preserves safe structured source output`);
	}
	for (const toolName of ["bash", "program"]) {
		const result = await toolResult(toolName, {}, 'export API_TOKEN="example-value"');
		assert.deepEqual(result.content.map((part) => part.text), ['export API_TOKEN="[REDACTED]"', REDACTION_NOTICE]);
	}

	// Redaction never trims the tool's own output, so its truncation footer survives.
	const footer = "[Showing lines 1-9 of 99. Full output: /tmp/pi-bash-example/output.txt]";
	const bashResult = await toolResult(
		"bash",
		{ command: "printenv" },
		`API_TOKEN=${"s".repeat(24)}\n${"x".repeat(DEFAULT_MAX_BYTES)}\ntail line\n\n${footer}`,
	);
	const bashText = textOf(bashResult);
	assert.ok(bashText.includes(footer), "bash keeps its own full-output footer");
	assert.ok(bashText.includes("tail line"), "nothing is trimmed to make room for the notice");
	assert.ok(!bashText.includes("s".repeat(24)), "the secret is gone");
	assert.ok(bashText.endsWith(REDACTION_NOTICE), "the notice follows the tool's own footer");

	const shortResult = await toolResult("read", { path: "/tmp/app.yaml" }, "password: abcdef123456");
	assert.deepEqual(shortResult.content.map((part) => part.text), ["password: [REDACTED]", REDACTION_NOTICE]);

	const cleanPreview = `Clean truncated preview\n\n${footer}`;
	const structuredCases = [
		{ toolName: "bash", input: { command: "fixture" }, value: { output: `safe\nAPI_TOKEN=${"s".repeat(24)}`, truncated: false, exit_code: 0 } },
		{ toolName: "bash", input: { command: "fixture" }, value: { nested: [null, 42, { text: `-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----` }] } },
		{ toolName: "read", input: { path: "/tmp/config.json" }, value: { nested: { refresh_token: "abcdef123456" } } },
	];
	for (const fixture of structuredCases) {
		const event = {
			type: "tool_result", toolCallId: "structured", toolName: fixture.toolName, input: fixture.input,
			isError: false, content: [{ type: "text", text: cleanPreview }],
			structuredContent: fixture.value,
		};
		const before = structuredClone(event);
		const result = await handlers.tool_result(event);
		assert.ok(result, "secrets outside the text preview trigger redaction");
		assert.equal("structuredContent" in result, false, "the unsafe structured output is not returned");
		assert.deepEqual(result.content.map((part) => part.text), [cleanPreview, REDACTION_NOTICE]);
		assert.deepEqual(event, before, "the original result is not mutated");
	}
	const safeStructured = await handlers.tool_result({
		toolName: "read", input: { path: "/tmp/source.ts" }, content: [{ type: "text", text: "safe" }],
		structuredContent: { output: "const token = parseToken(input);", nested: [null, true, 42] },
	});
	assert.equal(safeStructured, undefined, "safe structured output passes through unchanged");

	console.log("secret-guard: path blocking and text/structured redaction passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
