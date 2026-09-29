const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");

const EXTENSIONS_DIR = dirname(__dirname);
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
	const { scrubOutput } = await jiti.import(join(EXTENSIONS_DIR, "secret-guard/redact.js"));
	const register = await jiti.import(join(EXTENSIONS_DIR, "secret-guard/index.ts"), { default: true });

	const handlers = {};
	let notifications = 0;
	register({ on: (name, handler) => { handlers[name] = handler; } });
	const toolCall = (toolName, input) =>
		handlers.tool_call(
			{ type: "tool_call", toolCallId: "call", toolName, input },
			{ hasUI: true, ui: { notify() { notifications++; } } },
		);
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

	// Layer 1: credential paths are blocked for every tool that can reveal their contents.
	assert.deepEqual(await toolCall("read", { path: `~/${NETRC}` }), { block: true, reason: `Sensitive file (${NETRC})` });
	assert.equal((await toolCall("grep", { pattern: "password", path: `/Users/x/${NETRC}` })).block, true);
	assert.equal((await toolCall("grep", { pattern: "key", path: "~/.aws/credentials" })).block, true);
	assert.equal((await toolCall("bash", { command: `cat ~/${NETRC}` })).block, true);
	assert.equal((await toolCall("write", { path: "~/.ssh/id_ed25519" })).block, true);
	assert.equal(await toolCall("grep", { pattern: "token", path: "src/app.ts" }), undefined);
	assert.equal(await toolCall("grep", { pattern: "token" }), undefined, "grep without a path still runs");
	assert.equal(await toolCall("find", { pattern: "*", path: "~/.ssh" }), undefined, "find only lists names");
	assert.equal(notifications, 0, "blocked tool results do not duplicate their reason as UI notifications");

	// Layer 2: config keys carry vendor prefixes and suffixes.
	const configOptions = { envAssignments: true, genericFields: true };
	for (const line of [
		'"exaApiKey": "exa-abcdef123456"',
		'"ANTHROPIC_API_KEY": "abcdef123456"',
		"aws_secret_access_key = wJalrXUtnFEMIKEXAMPLEKEY",
		"AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIKEXAMPLEKEY",
		"refresh_token: abcdef123456",
	]) {
		assert.match(scrubOutput(line, configOptions), /\[REDACTED\]/, line);
	}
	// A lowercase letter right after the keyword continues a different word.
	for (const line of ["tokenizer: sentencepiece", "tokenizer_path: /mnt/models/ling", "max_tokens: 128000", "secretariat: geneva-office"]) {
		assert.equal(scrubOutput(line, configOptions), line);
	}
	// Reading source files keeps assignments intact; vendor token shapes are always removed.
	assert.equal(scrubOutput("const token = parseToken(input);", {}), "const token = parseToken(input);");
	assert.match(scrubOutput(`API_TOKEN=${"s".repeat(24)}`, { envAssignments: true }), /API_TOKEN=\[REDACTED\]/);
	assert.match(scrubOutput("Authorization: Bearer abcdefghijklmnopqrstuvwxyz", {}), /Bearer \[REDACTED\]/);

	const untouched = await toolResult("read", { path: "src/app.ts" }, "const timeout = 30;");
	assert.equal(untouched, undefined, "results without secrets pass through unchanged");

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

	const { ExtensionRunner } = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/extensions/runner.js")));
	const runner = {
		extensions: [{ path: "secret-guard", handlers: new Map([["tool_result", [handlers.tool_result]]]) }],
		createContext: () => ({}),
		emitError: (error) => { throw new Error(error.error); },
	};
	const cleanPreview = `Clean truncated preview\n\n${footer}`;
	const details = { truncation: { truncated: true }, fullOutputPath: "/tmp/pi-bash-example/output.txt" };
	const structuredCases = [
		{ toolName: "bash", input: { command: "fixture" }, value: { output: `safe\nAPI_TOKEN=${"s".repeat(24)}`, truncated: false, exit_code: 0 } },
		{ toolName: "bash", input: { command: "fixture" }, value: { nested: [null, 42, { text: `-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----` }] } },
		{ toolName: "read", input: { path: "/tmp/config.json" }, value: { nested: { refresh_token: "abcdef123456" } } },
	];
	for (const fixture of structuredCases) {
		const event = {
			type: "tool_result", toolCallId: "structured", toolName: fixture.toolName, input: fixture.input,
			isError: false, content: [{ type: "text", text: cleanPreview }], details,
			structuredContent: fixture.value,
		};
		const before = structuredClone(event);
		const result = await ExtensionRunner.prototype.emitToolResult.call(runner, event);
		assert.ok(result, "secrets outside the text preview trigger redaction");
		assert.equal(result.structuredContent, undefined, "Pi drops unsafe structured output");
		assert.deepEqual(result.content.map((part) => part.text), [cleanPreview, REDACTION_NOTICE]);
		assert.deepEqual(result.details, details, "truncation metadata survives");
		assert.deepEqual(event, before, "the original result is not mutated");
	}
	const safeStructured = await handlers.tool_result({
		toolName: "read", input: { path: "/tmp/source.ts" }, content: [{ type: "text", text: "safe" }],
		structuredContent: { output: "const token = parseToken(input);", nested: [null, true, 42] },
	});
	assert.equal(safeStructured, undefined, "safe structured output passes through unchanged");

	console.log("secret-guard: path blocking, text/structured redaction, and metadata preservation passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
