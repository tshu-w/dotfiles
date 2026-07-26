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
process.on("SIGTERM", () => appendFileSync(process.env.PI_SSH_SMOKE_LOG, "TERM\\n"));
setTimeout(() => process.exit(0), 5000);
`);
	chmodSync(fakeSsh, 0o755);

	const savedEnv = Object.fromEntries(["PATH", "PI_SSH_REMOTE", "PI_SSH_REMOTE_CWD", "PI_SSH_LOCAL_CWD", "PI_SSH_SMOKE_LOG"].map(name => [name, process.env[name]]));
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
		const module = await jiti.import(join(EXTENSIONS_DIR, "ssh.ts"));
		const tools = new Map();
		const handlers = new Map();
		module.default({
			appendEntry() {},
			getFlag() { return undefined; },
			on(name, handler) { handlers.set(name, handler); },
			registerCommand() {},
			registerFlag() {},
			registerTool(tool) { tools.set(tool.name, tool); },
			sendMessage() {},
		});
		const ctx = {
			cwd: EXTENSIONS_DIR,
			hasUI: false,
			sessionManager: { getEntries: () => [] },
			ui: { notify() {}, setStatus() {}, theme: { fg: (_color, text) => text } },
		};
		await handlers.get("session_start")({ reason: "startup" }, ctx);

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
