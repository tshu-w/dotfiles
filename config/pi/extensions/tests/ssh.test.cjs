const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const EXTENSIONS_DIR = dirname(__dirname);
const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

async function waitFor(predicate, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for fake ssh");
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

async function main() {
	const root = mkdtempSync(join(tmpdir(), "pi-ssh-smoke-"));
	const fakeSsh = join(root, "ssh");
	const signalLog = join(root, "signals.log");
	writeFileSync(fakeSsh, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.PI_SSH_SMOKE_LOG, "ready\\n");
if (process.env.PI_SSH_SMOKE_MODE === "error") {
	const text = process.env.PI_SSH_SMOKE_LINES === "1"
		? Array.from({ length: 2100 }, (_, i) => "line " + i).join("\\n")
		: "e".repeat(60 * 1024);
	process.stderr.write(text);
	process.exit(2);
}
process.on("SIGTERM", () => appendFileSync(process.env.PI_SSH_SMOKE_LOG, "TERM\\n"));
setTimeout(() => process.exit(0), 5000);
`);
	chmodSync(fakeSsh, 0o755);

	const savedEnv = Object.fromEntries(["PATH", "TMPDIR", "PI_SSH_REMOTE", "PI_SSH_REMOTE_CWD", "PI_SSH_LOCAL_CWD", "PI_SSH_SMOKE_LOG", "PI_SSH_SMOKE_MODE", "PI_SSH_SMOKE_LINES"].map(name => [name, process.env[name]]));
	process.env.PATH = `${root}:${process.env.PATH}`;
	process.env.PI_SSH_REMOTE = "fake-host";
	process.env.PI_SSH_REMOTE_CWD = "/remote";
	process.env.PI_SSH_LOCAL_CWD = EXTENSIONS_DIR;
	process.env.PI_SSH_SMOKE_LOG = signalLog;

	try {
		const jiti = createJiti(join(root, "loader.cjs"), {
			interopDefault: true,
			alias: {
				"@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js`,
				"@earendil-works/pi-tui": `${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`,
			},
		});
		const { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } = await jiti.import(`${PI_PACKAGE}/dist/index.js`);
		const module = await jiti.import(join(EXTENSIONS_DIR, "ssh.ts"));
		const tools = new Map();
		const handlers = new Map();
		const commands = new Map();
		const messages = [];
		module.default({
			appendEntry() {},
			getFlag() { return undefined; },
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, command) { commands.set(name, command); },
			registerFlag() {},
			registerTool(tool) { tools.set(tool.name, tool); },
			sendMessage(message) { messages.push(message); },
		});
		const ctx = {
			cwd: EXTENSIONS_DIR,
			hasUI: false,
			sessionManager: { getEntries: () => [] },
			ui: { notify() {}, setStatus() {}, theme: { fg: (_color, text) => text } },
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);

		await commands.get("ssh").handler(`fake-host:/${"x".repeat(60 * 1024)}`, ctx);
		assert.ok(messages.length > 0);
		const statusMessage = messages.at(-1).content;
		// The limits bound the content; the truncation notice sits on top of it.
		const statusContent = statusMessage.split("\n[SSH status truncated")[0];
		assert.ok(Buffer.byteLength(statusContent) <= DEFAULT_MAX_BYTES, "SSH status content stays within Pi's byte bound");
		assert.ok(statusContent.split("\n").length <= DEFAULT_MAX_LINES, "SSH status content stays within Pi's line bound");
		assert.match(statusMessage, /SSH status truncated/);
		await commands.get("ssh").handler("fake-host:/remote", ctx);

		const fileToolCases = [
			["read", { path: "large.txt" }],
			["write", { path: "large.txt", content: "content" }],
			["edit", { path: "large.txt", edits: [{ oldText: "old", newText: "new" }] }],
		];
		for (const [name, params] of fileToolCases) {
			const controller = new AbortController();
			const started = Date.now();
			const readyCount = existsSync(signalLog) ? readFileSync(signalLog, "utf8").split("ready").length : 1;
			const promise = tools.get(name).execute(name, params, controller.signal, undefined, ctx);
			await waitFor(() => existsSync(signalLog) && readFileSync(signalLog, "utf8").split("ready").length > readyCount);
			controller.abort();
			await assert.rejects(promise, /aborted/);
			assert.ok(Date.now() - started < 1500, `remote ${name} abort has a hard settle bound`);
		}

		for (const lineMode of [false, true]) {
			process.env.PI_SSH_SMOKE_MODE = "error";
			if (lineMode) process.env.PI_SSH_SMOKE_LINES = "1";
			const sshError = await tools.get("read").execute("read-error", { path: "large.txt" }, undefined, undefined, ctx)
				.then(() => null, (error) => error);
			delete process.env.PI_SSH_SMOKE_MODE;
			delete process.env.PI_SSH_SMOKE_LINES;
			assert.ok(sshError instanceof Error);
			const errorContent = sshError.message.split("\n\n[SSH error truncated:")[0];
			assert.ok(Buffer.byteLength(errorContent) <= DEFAULT_MAX_BYTES, "remote stderr content stays within Pi's byte bound");
			assert.ok(errorContent.split("\n").length <= DEFAULT_MAX_LINES, "remote stderr content stays within Pi's line bound");
			assert.match(sshError.message, /SSH error truncated: showing the last/);
			if (!lineMode) assert.ok(sshError.message.includes("e".repeat(1000)), "single-line stderr keeps a useful tail preview");
			const fullErrorPath = sshError.message.match(/Full error: (.+?\/output\.txt)\./)?.[1];
			assert.ok(fullErrorPath, "truncated SSH errors retain a full-output path");
			assert.ok(readFileSync(fullErrorPath, "utf8").length > 2000);
			rmSync(dirname(fullErrorPath), { recursive: true, force: true });
		}

		process.env.PI_SSH_SMOKE_MODE = "error";
		process.env.TMPDIR = join(root, "missing", "tmp");
		const unsavedError = await tools.get("read").execute("read-unsaved-error", { path: "large.txt" }, undefined, undefined, ctx)
			.then(() => null, (error) => error);
		delete process.env.PI_SSH_SMOKE_MODE;
		if (savedEnv.TMPDIR === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedEnv.TMPDIR;
		assert.ok(unsavedError instanceof Error);
		assert.match(unsavedError.message, /Full error could not be saved to a temporary file/);
		assert.match(unsavedError.message, /rerun the command only if safe/);
		assert.ok(Buffer.byteLength(unsavedError.message.split("\n\n[SSH error truncated:")[0]) <= DEFAULT_MAX_BYTES);

		const bashOps = handlers.get("user_bash")().operations;
		const timeoutStarted = Date.now();
		await assert.rejects(
			bashOps.exec("sleep forever", EXTENSIONS_DIR, { onData() {}, timeout: 0.2 }),
			/timeout:0.2/,
		);
		assert.ok(Date.now() - timeoutStarted < 1500, "remote bash timeout has a hard settle bound");

		const bashController = new AbortController();
		const abortStarted = Date.now();
		const readyCount = readFileSync(signalLog, "utf8").split("ready").length;
		const bashPromise = bashOps.exec("sleep forever", EXTENSIONS_DIR, { onData() {}, signal: bashController.signal });
		await waitFor(() => readFileSync(signalLog, "utf8").split("ready").length > readyCount);
		bashController.abort();
		await assert.rejects(bashPromise, /aborted/);
		assert.ok(Date.now() - abortStarted < 1500, "remote bash abort has a hard settle bound");

		assert.ok(readFileSync(signalLog, "utf8").split("TERM").length >= 6, "each stopped ssh process receives SIGTERM");
		console.log("ssh: file-tool aborts and remote bash timeout/abort settle bounds passed");
	} finally {
		for (const [name, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
