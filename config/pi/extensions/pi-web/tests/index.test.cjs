const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
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
			"@earendil-works/pi-tui": `${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`,
			typebox: `${PI_PACKAGE}/node_modules/typebox/build/index.mjs`,
		},
	});
	const { DEFAULT_MAX_BYTES: MAX_BYTES, DEFAULT_MAX_LINES: MAX_LINES } = await jiti.import(`${PI_PACKAGE}/dist/index.js`);
	const module = await jiti.import("../index.ts");
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

	const originalTmpdir = process.env.TMPDIR;
	try {
		process.env.TMPDIR = join(tmpdir(), `pi-web-missing-${Date.now()}`, "nested");
		const result = await boundToolOutput("x".repeat(MAX_BYTES + 1000));
		assert.equal(result.truncated, true);
		assert.equal(result.fullOutputPath, undefined);
		assert.match(result.text, /Full output could not be saved to a temporary file/);
		assert.match(result.text, /Rerun or narrow the request/);
		assert.ok(Buffer.byteLength(result.text) <= MAX_BYTES);
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
	}

	const longTmpOriginal = process.env.TMPDIR;
	const longTmpRoot = mkdtempSync(join(tmpdir(), "pi-web-long-tmp-"));
	const longTmpdir = join(longTmpRoot, ...Array.from({ length: 8 }, (_, i) => `${i}-${"t".repeat(90)}`));
	mkdirSync(longTmpdir, { recursive: true });
	try {
		process.env.TMPDIR = longTmpdir;
		const result = await boundToolOutput("x".repeat(MAX_BYTES + 1000));
		assert.ok(Buffer.byteLength(result.fullOutputPath) > 512, "regression requires a long temp path");
		assert.ok(result.text.includes(result.fullOutputPath), "the model-visible notice keeps the long temp path");
		assert.ok(Buffer.byteLength(result.text) <= MAX_BYTES, "long temp path stays within byte limit");
		assert.ok(result.text.split("\n").length <= MAX_LINES, "long temp path stays within line limit");
	} finally {
		if (longTmpOriginal === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = longTmpOriginal;
		rmSync(longTmpRoot, { recursive: true });
	}

	// Single huge lines must fill the byte budget with a partial line rather
	// than truncating to (nearly) nothing, and never split a code point.
	for (const input of ["x".repeat(MAX_BYTES + 1000), "中".repeat(MAX_BYTES), "😀".repeat(20000)]) {
		const result = await boundToolOutput(input);
		assert.ok(Buffer.byteLength(result.text) > MAX_BYTES - 2048, `single-line preview keeps the budget, got ${Buffer.byteLength(result.text)}`);
		assert.ok(!result.text.includes("\uFFFD"), "no replacement characters");
		assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result.text), "no lone surrogates");
		rmSync(dirname(result.fullOutputPath), { recursive: true });
	}

	const tools = new Map();
	module.default({ registerTool(tool) { tools.set(tool.name, tool); } });
	const search = tools.get("web_search");
	const fetchTool = tools.get("web_fetch");
	assert.ok(search && fetchTool);
	const callStyles = [];
	const callTheme = {
		bold: (text) => `<b>${text}</b>`,
		fg: (color, text) => { callStyles.push([color, text]); return text; },
	};
	const searchArgs = { query: "Qwen release", numResults: 5 };
	const expectedSearch = '<b>web_search</b>(query="Qwen release", numResults=5)';
	assert.deepEqual(search.renderCall(searchArgs, callTheme, { isPartial: true }).render(1000).map((line) => line.trimEnd()), [expectedSearch]);
	assert.deepEqual(search.renderCall(searchArgs, callTheme, { isPartial: false }).render(1000).map((line) => line.trimEnd()), [expectedSearch, ""]);
	const fetchArgs = { url: "https://example.com", maxChars: 80_000, pattern: "release notes" };
	const expectedFetch = '<b>web_fetch</b>(url="https://example.com", maxChars=80000, pattern="release notes")';
	assert.deepEqual(fetchTool.renderCall(fetchArgs, callTheme, { isPartial: true }).render(1000).map((line) => line.trimEnd()), [expectedFetch]);
	assert.deepEqual(fetchTool.renderCall(fetchArgs, callTheme, { isPartial: false }).render(1000).map((line) => line.trimEnd()), [expectedFetch, ""]);
	assert.equal(callStyles.filter(([color]) => color === "toolTitle").length, 4);
	assert.equal(callStyles.some(([color]) => color === "muted"), false);
	assert.equal(callStyles.some(([color]) => color === "accent"), false);
	const renderedFetch = fetchTool.renderResult(
		{ content: [{ type: "text", text: "body" }], details: { title: "Example", chars: 4 } },
		{ expanded: false, isPartial: false },
		callTheme,
		{ args: fetchArgs, isError: false },
	).render(1000).join("\n");
	assert.match(renderedFetch, /\[find: "release notes"\]/, "renderer reads pattern from tool-call args");

	const originalFetch = global.fetch;
	const originalKeys = {
		exa: process.env.EXA_API_KEY,
		jina: process.env.JINA_API_KEY,
		tavily: process.env.TAVILY_API_KEY,
	};
	const longPage = "x".repeat(80_000);
	global.fetch = async (url) => String(url) === "https://example.com/"
		? new Response(longPage, { status: 200, headers: { "content-type": "text/plain" } })
		: new Response("provider unavailable", { status: 503 });
	try {
		const longResult = await fetchTool.execute("test", { url: "https://example.com", maxChars: 80_000 }, undefined, undefined);
		assert.deepEqual(Object.keys(longResult.details).sort(), ["chars", "fullOutputPath", "title", "truncated"]);
		assert.equal(longResult.details.truncated, true);
		assert.ok(Buffer.byteLength(longResult.content[0].text) <= MAX_BYTES);
		assert.equal(readFileSync(longResult.details.fullOutputPath, "utf8"), `# example.com\n\n${longPage}`);
		rmSync(dirname(longResult.details.fullOutputPath), { recursive: true });

		delete process.env.EXA_API_KEY;
		delete process.env.JINA_API_KEY;
		process.env.TAVILY_API_KEY = "test-key";
		const longAnswer = "y".repeat(80_000);
		global.fetch = async () => new Response(JSON.stringify({
			answer: longAnswer,
			results: [{ title: "Example", url: "https://example.com", content: "snippet" }],
		}), { status: 200, headers: { "content-type": "application/json" } });
		const longSearchResult = await search.execute("test", { query: "test" }, undefined, undefined);
		assert.deepEqual(Object.keys(longSearchResult.details).sort(), ["count", "fullOutputPath", "truncated"]);
		assert.equal(longSearchResult.details.truncated, true);
		assert.ok(Buffer.byteLength(longSearchResult.content[0].text) <= MAX_BYTES);
		assert.equal(readFileSync(longSearchResult.details.fullOutputPath, "utf8"), `${longAnswer}\n\n---\n\nSources:\nsnippet\nSource: Example (https://example.com)`);
		rmSync(dirname(longSearchResult.details.fullOutputPath), { recursive: true });

		delete process.env.TAVILY_API_KEY;
		global.fetch = async () => new Response("provider unavailable", { status: 503 });
		await assert.rejects(
			search.execute("test", { query: "test" }, undefined, undefined),
			/Web search failed: All search providers failed/,
		);
		await assert.rejects(
			fetchTool.execute("test", { url: "file:///tmp/test" }, undefined, undefined),
			/Web fetch failed.*Only http and https URLs are supported/,
		);

		process.env.TAVILY_API_KEY = "test-key";
		global.fetch = async () => { throw new Error("e".repeat(60 * 1024)); };
		const oversizedSearchError = await search.execute("test", { query: "test" }, undefined, undefined)
			.then(() => null, (error) => error);
		delete process.env.TAVILY_API_KEY;
		assert.ok(oversizedSearchError instanceof Error);
		assert.ok(Buffer.byteLength(oversizedSearchError.message) <= MAX_BYTES);
		assert.ok(oversizedSearchError.message.split("\n").length <= MAX_LINES);
		const errorOutputPath = oversizedSearchError.message.match(/Full output: (.+?\/output\.txt)\./)?.[1];
		assert.ok(errorOutputPath, "oversized provider errors retain a full-output path");
		rmSync(dirname(errorOutputPath), { recursive: true });

		const oversizedUrlError = await fetchTool.execute(
			"test",
			{ url: `https://${"x".repeat(60_000)}.invalid` },
			undefined,
			undefined,
		).then(() => null, (error) => error);
		assert.ok(oversizedUrlError instanceof Error);
		assert.ok(Buffer.byteLength(oversizedUrlError.message) <= MAX_BYTES, "web_fetch errors must not reflect the full URL");
		assert.ok(oversizedUrlError.message.split("\n").length <= MAX_LINES);
	} finally {
		global.fetch = originalFetch;
		for (const [name, value] of Object.entries({ EXA_API_KEY: originalKeys.exa, JINA_API_KEY: originalKeys.jina, TAVILY_API_KEY: originalKeys.tavily })) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}

	console.log("pi-web: 8 output-bound cases, 2 integration cases, and 4 error cases passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
