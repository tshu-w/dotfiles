const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, realpathSync, utimesSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
// Keep the once-per-process orphan cleanup away from the real state directory.
globalThis[Symbol.for("pi-custom:claude-orphans-removed")] = true;

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));
let custom;

before(async () => {
	const jiti = createJiti(__filename, {
		interopDefault: true,
		alias: {
			"@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js`,
			"@earendil-works/pi-ai/compat": `${PI_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
			"@earendil-works/pi-ai": `${PI_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
			"@earendil-works/pi-tui": `${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`,
		},
	});
	custom = await jiti.import("../index.ts");
});

test("one Pi instance claims each package update and a crashed claim expires", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-custom-update-"));
	const state = join(directory, "package-update.json"), lock = join(directory, "package-update.lock");
	const now = Date.now();
	assert.equal(custom.claimPackageUpdate(state, lock, now), true);
	assert.equal(custom.claimPackageUpdate(state, lock, now + 1), false);
	assert.equal(existsSync(lock), false);
	// Another instance holds the lock: skip, unless the lock was left long ago.
	const later = now + 7 * 60 * 60 * 1000;
	writeFileSync(lock, "");
	utimesSync(lock, new Date(later - 1000), new Date(later - 1000));
	assert.equal(custom.claimPackageUpdate(state, lock, later), false);
	utimesSync(lock, new Date(later - 120_000), new Date(later - 120_000));
	assert.equal(custom.claimPackageUpdate(state, lock, later), true);
});

test("only git package clones with local work are reported", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-custom-git-"));
	const { mkdirSync } = require("node:fs");
	for (const repo of ["dirty", "clean", "plain"]) mkdirSync(join(root, "host", "owner", repo), { recursive: true });
	writeFileSync(join(root, "README"), "not a host directory");
	for (const repo of ["dirty", "clean"]) execFileSync("git", ["init", "-q", join(root, "host", "owner", repo)]);
	writeFileSync(join(root, "host", "owner", "dirty", "notes.txt"), "local work");
	assert.deepEqual(await custom.findDirtyGitPackages(root), ["owner/dirty"]);
});
