const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const EXTENSIONS = [join(__dirname, "../index.ts"), join(__dirname, "../title-status.ts")];

async function main() {
	const loader = await import(pathToFileURL(join(PI_PACKAGE, "dist/core/extensions/loader.js")).href);
	const result = await loader.loadExtensions(EXTENSIONS, process.cwd());

	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 2);
	console.log("pi-custom: production extension loader verified");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
