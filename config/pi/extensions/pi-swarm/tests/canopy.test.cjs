const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const { dirname, join } = require("node:path");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

async function main() {
	const jiti = createJiti(__filename, {
		interopDefault: true,
		alias: {
			"@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js`,
		},
	});
	const { SettingsManager } = await import(`${PI_PACKAGE}/dist/index.js`);
	const { createChildResourceLoader } = await jiti.import("../canopy.ts");
	const root = mkdtempSync(join(os.tmpdir(), "pi-swarm-canopy-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const safePath = join(root, "safe.ts");
	const unsafePath = join(root, "unsafe.ts");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(cwd, "AGENTS.md"), "# Child context\n", "utf8");
	writeFileSync(safePath, `export default function () { globalThis.__piSwarmSafeLoaded = (globalThis.__piSwarmSafeLoaded ?? 0) + 1; }\n`, "utf8");
	writeFileSync(unsafePath, `globalThis.__piSwarmUnsafeImported = true; export default function () { globalThis.__piSwarmUnsafeStarted = true; }\n`, "utf8");

	const globals = globalThis;
	delete globals.__piSwarmSafeLoaded;
	delete globals.__piSwarmUnsafeImported;
	delete globals.__piSwarmUnsafeStarted;
	try {
		const settingsManager = SettingsManager.inMemory({ extensions: [unsafePath] });
		const loader = await createChildResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionPaths: [safePath],
		});

		assert.equal(globals.__piSwarmSafeLoaded, 1);
		assert.equal(globals.__piSwarmUnsafeImported, undefined);
		assert.equal(globals.__piSwarmUnsafeStarted, undefined);
		assert.deepEqual(loader.getExtensions().extensions.map((extension) => extension.resolvedPath), [safePath]);
		assert.equal(loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(cwd, "AGENTS.md")), true);
	} finally {
		delete globals.__piSwarmSafeLoaded;
		delete globals.__piSwarmUnsafeImported;
		delete globals.__piSwarmUnsafeStarted;
		rmSync(root, { recursive: true, force: true });
	}

	console.log("pi-swarm canopy: child extension allowlist passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
