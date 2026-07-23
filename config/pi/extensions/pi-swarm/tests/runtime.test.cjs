const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

async function main() {
	const {
		createAgentSession,
		DefaultResourceLoader,
		getAgentDir,
		SessionManager,
		SettingsManager,
	} = await import(`${PI_PACKAGE}/dist/index.js`);
	const cwd = "/tmp/pi-swarm-runtime-test";
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		additionalExtensionPaths: [join(__dirname, "..", "index.ts")],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const rootSessionManager = SessionManager.inMemory(cwd);
	rootSessionManager.appendMessage({ role: "user", content: "parent-context-marker", timestamp: Date.now() });
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: rootSessionManager,
		tools: ["agent"],
	});
	await session.bindExtensions({ mode: "print" });
	assert.deepEqual(session.getActiveToolNames(), ["agent"]);
	assert.equal(rootSessionManager.buildSessionContext().messages.at(-1)?.content, "parent-context-marker");

	const childAgentDir = mkdtempSync(join(tmpdir(), "pi-swarm-runtime-"));
	try {
		const jiti = createJiti(__filename, {
			interopDefault: true,
			alias: {
				"@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js`,
				"@earendil-works/pi-ai/compat": `${PI_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
				"@earendil-works/pi-tui": `${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`,
				typebox: `${PI_PACKAGE}/node_modules/typebox/build/index.mjs`,
			},
		});
		const { PiCanopyHost } = await jiti.import("../index.ts");
		const host = new PiCanopyHost({
			getThinkingLevel: () => "high",
			getActiveTools: () => ["agent"],
			appendEntry() {},
			sendMessage() {},
		}, childAgentDir, "runtime-root", "runtime-parent");
		host.setContext(session.extensionRunner.createContext());
		const prepared = host.prepareChild({ message: "prepare without prompting" });
		const forked = host.prepareChild({ message: "fork without prompting", context: "fork" });
		const forkText = readFileSync(forked.sessionFile, "utf8");
		assert.ok(forkText.includes("parent-context-marker"), forkText);
		const forkContext = SessionManager.open(forked.sessionFile, dirname(forked.sessionFile), cwd).buildSessionContext();
		assert.equal(forkContext.messages.at(-1).content, "parent-context-marker");
		const timestamp = new Date().toISOString();
		const child = { ...prepared, status: "running", consumed: false, createdAt: timestamp, updatedAt: timestamp };
		const runtime = await host.ensureRuntime(child);
		assert.deepEqual(runtime.session.getActiveToolNames(), ["agent"]);
		assert.deepEqual(runtime.session.messages, []);
		assert.deepEqual(runtime.session.extensionRunner.getExtensionPaths(), [join(__dirname, "..", "index.ts")]);
		assert.ok(prepared.sessionFile.startsWith(childAgentDir));
		await host.shutdownChild(child);
	} finally {
		rmSync(childAgentDir, { recursive: true, force: true });
	}

	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
	console.log("pi-swarm: root binding and child session lifecycle passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
