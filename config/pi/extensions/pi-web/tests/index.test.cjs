const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

function spillPathOf(text) {
	return text.match(/Full output saved to: (.+?\/output\.txt)\]/)?.[1];
}

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
		assert.match(result.text, /Full output could not be saved/);
		assert.doesNotMatch(result.text, /temporary file|Rerun or narrow/);
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
	assert.equal(search.parameters.additionalProperties, false);
	assert.deepEqual(
		{
			query: { type: search.parameters.properties.query.type, minLength: search.parameters.properties.query.minLength, pattern: search.parameters.properties.query.pattern },
			numResults: {
				type: search.parameters.properties.numResults.type,
				minimum: search.parameters.properties.numResults.minimum,
				maximum: search.parameters.properties.numResults.maximum,
			},
		},
		{ query: { type: "string", minLength: 1, pattern: "\\S" }, numResults: { type: "integer", minimum: 1, maximum: 10 } },
	);
	assert.equal(fetchTool.parameters.additionalProperties, false);
	assert.deepEqual(
		{
			url: { type: fetchTool.parameters.properties.url.type, minLength: fetchTool.parameters.properties.url.minLength, pattern: fetchTool.parameters.properties.url.pattern },
			maxChars: {
				type: fetchTool.parameters.properties.maxChars.type,
				minimum: fetchTool.parameters.properties.maxChars.minimum,
				maximum: fetchTool.parameters.properties.maxChars.maximum,
			},
			pattern: { type: fetchTool.parameters.properties.pattern.type, minLength: fetchTool.parameters.properties.pattern.minLength, pattern: fetchTool.parameters.properties.pattern.pattern },
		},
		{
			url: { type: "string", minLength: 1, pattern: "\\S" },
			maxChars: { type: "integer", minimum: 1, maximum: 80_000 },
			pattern: { type: "string", minLength: 1, pattern: "\\S" },
		},
	);
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
		blockedDomains: process.env.WEB_FETCH_BLOCKED_DOMAINS,
	};
	const longPage = "x".repeat(80_000);
	global.fetch = async (url) => String(url) === "https://example.com/"
		? new Response(longPage, { status: 200, headers: { "content-type": "text/plain" } })
		: new Response("provider unavailable", { status: 503 });
	try {
		const longResult = await fetchTool.execute("test", { url: "https://example.com", maxChars: 80_000 }, undefined, undefined);
		assert.deepEqual(Object.keys(longResult.details).sort(), ["chars", "title", "truncated"]);
		assert.equal(longResult.details.truncated, true);
		assert.ok(Buffer.byteLength(longResult.content[0].text) <= MAX_BYTES);
		const fetchSpillPath = spillPathOf(longResult.content[0].text);
		assert.ok(fetchSpillPath);
		assert.equal(readFileSync(fetchSpillPath, "utf8"), `# example.com\n\n${longPage}`);
		rmSync(dirname(fetchSpillPath), { recursive: true });
		const patternResult = await fetchTool.execute("test", {
			url: "https://example.com", maxChars: 80_000, pattern: "xxx",
		}, undefined, undefined);
		assert.match(patternResult.content[0].text, /^# example\.com\n\nFound 10 match\(es\) for "xxx":/);

		process.env.EXA_API_KEY = "unit-test";
		delete process.env.JINA_API_KEY;
		process.env.WEB_FETCH_BLOCKED_DOMAINS = ".corp.example.";
		for (const localUrl of [
			"http://localhost:8765/private",
			"http://10.0.0.1/private",
			"http://[::1]/private",
			"http://service.internal/private",
			"https://docs.corp.example/private",
		]) {
			let requests = 0;
			global.fetch = async () => { requests += 1; return new Response("unexpected", { status: 500 }); };
			await assert.rejects(
				fetchTool.execute("test", { url: localUrl }, undefined, undefined),
				/Local and private URLs are not supported/,
			);
			assert.equal(requests, 0);
		}

		let directFetchOptions;
		global.fetch = async (url, init) => {
			if (String(url) === "https://api.exa.ai/contents") return new Response("provider unavailable", { status: 503 });
			directFetchOptions = init;
			return new Response("public content ".repeat(10), { status: 200, headers: { "content-type": "text/plain" } });
		};
		await fetchTool.execute("test", { url: "http://93.184.216.34/page" }, undefined, undefined);
		assert.equal(directFetchOptions.redirect, "error");

		delete process.env.EXA_API_KEY;
		delete process.env.JINA_API_KEY;
		process.env.TAVILY_API_KEY = "test-key";
		let tavilyRequest;
		global.fetch = async (_url, init) => {
			tavilyRequest = JSON.parse(init.body);
			return new Response(JSON.stringify({
				answer: "provider-generated answer must stay hidden",
				results: [{ title: "Example", url: "https://example.com", content: "first\nsecond" }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const searchResult = await search.execute("test", { query: "test" }, undefined, undefined);
		assert.equal(tavilyRequest.include_answer, false);
		assert.deepEqual(searchResult.details, { count: 1, truncated: false });
		assert.equal(searchResult.content[0].text,
			"1. Example\n   URL: https://example.com\n   Snippet: first second");
		assert.doesNotMatch(searchResult.content[0].text, /provider-generated answer/);

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
		const errorOutputPath = spillPathOf(oversizedSearchError.message);
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

		process.env.TAVILY_API_KEY = "test-key";
		global.fetch = async () => { throw new Error("aborted upstream"); };
		const searchAbort = new AbortController();
		searchAbort.abort();
		await assert.rejects(
			search.execute("test", { query: "test" }, searchAbort.signal, undefined),
			/^Error: Search cancelled\.$/,
		);
		const fetchAbort = new AbortController();
		fetchAbort.abort();
		await assert.rejects(
			fetchTool.execute("test", { url: "https://example.com" }, fetchAbort.signal, undefined),
			/^Error: Fetch cancelled\.$/,
		);
	} finally {
		global.fetch = originalFetch;
		for (const [name, value] of Object.entries({
			EXA_API_KEY: originalKeys.exa,
			JINA_API_KEY: originalKeys.jina,
			TAVILY_API_KEY: originalKeys.tavily,
			WEB_FETCH_BLOCKED_DOMAINS: originalKeys.blockedDomains,
		})) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}

	console.log("pi-web: output bounds, schemas, provider normalization, cancellation, and errors passed");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
