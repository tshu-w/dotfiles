const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync, realpathSync, rmSync } = require("node:fs");
const { dirname, join } = require("node:path");

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

async function main() {
	const jiti = createJiti(__filename, {
		interopDefault: true,
		alias: {
			"@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js`,
			"@earendil-works/pi-ai/compat": `${PI_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
			"@earendil-works/pi-tui": `${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`,
			typebox: `${PI_PACKAGE}/node_modules/typebox/build/index.mjs`,
		},
	});
	const module = await jiti.import("./index.ts");
	const { boundToolOutput } = module;

	const short = await boundToolOutput("hello");
	assert.deepEqual(short, { text: "hello", truncated: false, bytes: 5 });

	for (const input of ["x".repeat(MAX_BYTES + 1000), "中".repeat(MAX_BYTES), Array.from({ length: MAX_LINES + 10 }, (_, i) => `line ${i}`).join("\n")]) {
		const result = await boundToolOutput(input);
		assert.equal(result.truncated, true);
		assert.ok(result.text.includes("[Output truncated: showing"));
		assert.ok(Buffer.byteLength(result.text) <= MAX_BYTES);
		assert.ok(result.text.split("\n").length <= MAX_LINES);
		assert.equal(readFileSync(result.fullOutputPath, "utf8"), input);
		rmSync(dirname(result.fullOutputPath), { recursive: true });
	}

	const tools = new Map();
	module.default({ registerTool(tool) { tools.set(tool.name, tool); } });
	const search = tools.get("web_search");
	const fetchTool = tools.get("web_fetch");
	assert.ok(search && fetchTool);

	const originalFetch = global.fetch;
	const longPage = "x".repeat(80_000);
	global.fetch = async (url) => String(url) === "https://example.com/"
		? new Response(longPage, { status: 200, headers: { "content-type": "text/plain" } })
		: new Response("provider unavailable", { status: 503 });
	try {
		const longResult = await fetchTool.execute("test", { url: "https://example.com", maxChars: 80_000 }, undefined, undefined);
		assert.equal(longResult.details.truncated, true);
		assert.ok(Buffer.byteLength(longResult.content[0].text) <= MAX_BYTES);
		assert.equal(readFileSync(longResult.details.fullOutputPath, "utf8"), `# example.com\n\n${longPage}`);
		rmSync(dirname(longResult.details.fullOutputPath), { recursive: true });

		global.fetch = async () => new Response("provider unavailable", { status: 503 });
		await assert.rejects(
			search.execute("test", { query: "test" }, undefined, undefined),
			/Web search failed: All search providers failed/,
		);
		await assert.rejects(
			fetchTool.execute("test", { url: "file:///tmp/test" }, undefined, undefined),
			/Web fetch failed.*Only http and https URLs are supported/,
		);
	} finally {
		global.fetch = originalFetch;
	}

	console.log("pi-web: 4 output-bound cases, 1 fetch integration case, and 2 error cases passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
