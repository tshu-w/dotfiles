const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

function spillPathOf(text) {
	return text.match(/Full output: (.+?\/output\.txt)\]/)?.[1];
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
	assert.deepEqual(short, { text: "hello" });

	const multiLine = Array.from({ length: MAX_LINES + 10 }, (_, i) => `line ${i}`).join("\n");
	const multiLineResult = await boundToolOutput(multiLine);
	assert.equal(multiLineResult.truncation.truncated, true);
	assert.ok(multiLineResult.text.includes("[Output truncated:"));
	assert.ok(multiLineResult.truncation.outputBytes <= MAX_BYTES);
	assert.ok(multiLineResult.truncation.outputLines <= MAX_LINES);
	assert.equal(readFileSync(multiLineResult.fullOutputPath, "utf8"), multiLine);
	rmSync(dirname(multiLineResult.fullOutputPath), { recursive: true });

	const originalTmpdir = process.env.TMPDIR;
	try {
		process.env.TMPDIR = join(tmpdir(), `pi-web-missing-${Date.now()}`, "nested");
		const result = await boundToolOutput("x".repeat(MAX_BYTES + 1000));
		assert.equal(result.truncation.truncated, true);
		assert.equal(result.fullOutputPath, undefined);
		assert.match(result.text, /Full output could not be saved to a temporary file/);
		assert.ok(result.truncation.outputBytes <= MAX_BYTES);
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
		assert.ok(result.truncation.outputBytes <= MAX_BYTES, "a long temp path does not shrink the retained content");
	} finally {
		if (longTmpOriginal === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = longTmpOriginal;
		rmSync(longTmpRoot, { recursive: true });
	}

	// Pi's truncateHead keeps whole lines, so an oversized first line yields
	// only the truncation notice while the complete value remains on disk.
	for (const input of ["x".repeat(MAX_BYTES + 1000), "中".repeat(MAX_BYTES), "😀".repeat(20000)]) {
		const result = await boundToolOutput(input);
		assert.equal(result.truncation.firstLineExceedsLimit, true);
		assert.ok(result.text.startsWith("[Output truncated:"));
		assert.ok(!result.text.includes("\uFFFD"), "no replacement characters");
		assert.equal(result.truncation.content, "");
		assert.equal(readFileSync(result.fullOutputPath, "utf8"), input);
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
	await assert.rejects(
		fetchTool.execute("test", { url: "https://example.com", pattern: "line one\nline two" }, undefined, undefined),
		/^Error: Pattern must not contain control characters\.$/,
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
		{ content: [{ type: "text", text: 'Title: Example\n\n3 matches for "release notes"\n\nMatch 1 of 3:\n...one...' }], details: { title: "Example", chars: 4 } },
		{ expanded: false, isPartial: false },
		callTheme,
		{ args: fetchArgs, isError: false },
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(renderedFetch, /^Example \(4 chars, 3 matches\)\n\.\.\. \(match excerpts hidden,/);
	assert.doesNotMatch(renderedFetch, /\[find:/);
	const noMatchesFetch = fetchTool.renderResult(
		{ content: [{ type: "text", text: 'Title: Example\n\nNo matches for "release notes".' }], details: { title: "Example", chars: 4 } },
		{ expanded: false, isPartial: false },
		callTheme,
		{ args: fetchArgs, isError: false },
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(noMatchesFetch, "Example (4 chars, no matches)");
	assert.doesNotMatch(noMatchesFetch, /expand/);
	const expandedContent = "Title: Example\n\n# Body\n\nfull result";
	const expandedFetch = fetchTool.renderResult(
		{ content: [{ type: "text", text: expandedContent }], details: { title: "Example", chars: 18 } },
		{ expanded: true, isPartial: false },
		callTheme,
		{ args: fetchArgs, isError: false },
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expandedFetch, expandedContent);
	const searchContent = "- Example — https://example.com\n  Snippet: release notes";
	const collapsedSearch = search.renderResult(
		{ content: [{ type: "text", text: searchContent }], details: { count: 1 } },
		{ expanded: false, isPartial: false },
		callTheme,
		{ args: searchArgs, isError: false },
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.match(collapsedSearch, /^- Example — https:\/\/example\.com\n\.\.\. \(snippets hidden,/);
	assert.doesNotMatch(collapsedSearch, /Snippet:/);
	const emptySearch = search.renderResult(
		{ content: [{ type: "text", text: "No results found." }], details: { count: 0 } },
		{ expanded: false, isPartial: false },
		callTheme,
		{ args: searchArgs, isError: false },
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(emptySearch, "No results found.");
	const expandedSearch = search.renderResult(
		{ content: [{ type: "text", text: searchContent }], details: { count: 1 } },
		{ expanded: true, isPartial: false },
		callTheme,
		{ args: searchArgs, isError: false },
	).render(1000).map((line) => line.trimEnd()).join("\n");
	assert.equal(expandedSearch, searchContent);

	const originalFetch = global.fetch;
	const originalKeys = {
		exa: process.env.EXA_API_KEY,
		jina: process.env.JINA_API_KEY,
		tavily: process.env.TAVILY_API_KEY,
	};
	const longPage = "x".repeat(80_000);
	const fetchUrls = [];
	try {
		process.env.EXA_API_KEY = "unit-test";
		const shortFetchUrls = [];
		global.fetch = async (url) => {
			shortFetchUrls.push(String(url));
			if (String(url) !== "https://api.exa.ai/contents") throw new Error(`Unexpected provider: ${url}`);
			return new Response(JSON.stringify({ results: [{ title: "Short", text: "OK" }] }), { status: 200 });
		};
		const shortResult = await fetchTool.execute("test", { url: "https://example.com", maxChars: 1 }, undefined, undefined);
		assert.equal(shortResult.content[0].text, "Title: Short\n\nO");
		assert.deepEqual(shortFetchUrls, ["https://api.exa.ai/contents"]);
		delete process.env.EXA_API_KEY;
		global.fetch = async (url) => {
			fetchUrls.push(String(url));
			return String(url) === "https://r.jina.ai/https://example.com/"
				? new Response(longPage, { status: 200, headers: { "content-type": "text/plain" } })
				: new Response("provider unavailable", { status: 503 });
		};

		const longResult = await fetchTool.execute("test", { url: "https://example.com", maxChars: 80_000 }, undefined, undefined);
		assert.deepEqual(Object.keys(longResult.details).sort(), ["chars", "fullOutputPath", "title", "truncation"]);
		assert.equal(longResult.details.truncation.truncated, true);
		assert.ok(longResult.details.truncation.outputBytes <= MAX_BYTES);
		const fetchSpillPath = spillPathOf(longResult.content[0].text);
		assert.ok(fetchSpillPath);
		assert.equal(longResult.details.fullOutputPath, fetchSpillPath);
		assert.equal(readFileSync(fetchSpillPath, "utf8"), `Title: example.com\n\n${longPage}`);
		rmSync(dirname(fetchSpillPath), { recursive: true });
		const patternResult = await fetchTool.execute("test", {
			url: "https://example.com", maxChars: 80_000, pattern: "xxx",
		}, undefined, undefined);
		assert.match(patternResult.content[0].text, /^Title: example\.com\n\n10 matches for "xxx"\n\nMatch 1 of 10:/);
		assert.match(patternResult.content[0].text, /\n\nMatch 10 of 10:/);
		assert.equal(fetchUrls.filter((url) => url === "https://r.jina.ai/https://example.com/").length, 2);
		assert.equal(fetchUrls.includes("https://example.com/"), false, "web_fetch does not fetch URLs directly");

		global.fetch = async (url) => String(url).startsWith("https://r.jina.ai/")
			? new Response(`Title: ${"t".repeat(350)}\u001b\u0007\n\nMarkdown Content:\n# Body title\n\n${"body ".repeat(30)}\u009b`, { status: 200 })
			: new Response("provider unavailable", { status: 503 });
		const sanitizedFetch = await fetchTool.execute("test", { url: "https://example.org" }, undefined, undefined);
		assert.equal(sanitizedFetch.details.title.length, 200);
		assert.doesNotMatch(sanitizedFetch.content[0].text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);

		global.fetch = async (url) => String(url).startsWith("https://r.jina.ai/")
			? new Response("OK", { status: 200 })
			: new Response("provider unavailable", { status: 503 });
		const shortJinaResult = await fetchTool.execute("test", { url: "https://short.example" }, undefined, undefined);
		assert.equal(shortJinaResult.content[0].text, "Title: short.example\n\nOK");

		process.env.JINA_API_KEY = "unit-test";
		const jinaAuthHeaders = [];
		global.fetch = async (url, init) => {
			if (!String(url).startsWith("https://r.jina.ai/")) return new Response("provider unavailable", { status: 503 });
			jinaAuthHeaders.push(init.headers.Authorization);
			if (init.headers.Authorization) return new Response("quota exhausted", { status: 402 });
			return new Response(`Title: Anonymous\n\nMarkdown Content:\n${"body ".repeat(30)}`, { status: 200 });
		};
		const anonymousFallback = await fetchTool.execute("test", { url: "https://example.net" }, undefined, undefined);
		assert.deepEqual(jinaAuthHeaders, ["Bearer unit-test", undefined]);
		assert.match(anonymousFallback.content[0].text, /^Title: Anonymous/);

		delete process.env.EXA_API_KEY;
		delete process.env.JINA_API_KEY;
		process.env.TAVILY_API_KEY = "test-key";
		let tavilyRequest;
		global.fetch = async (_url, init) => {
			tavilyRequest = JSON.parse(init.body);
			return new Response(JSON.stringify({
				answer: "provider-generated answer must stay hidden",
				results: [
					{ title: "Exam\u001bple\u0007", url: "https://example.com", content: "first\u001b\nsecond\u0007" },
					{ title: "Extra", url: "https://extra.example", content: "must be sliced" },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const searchResult = await search.execute("test", { query: "test", numResults: 1 }, undefined, undefined);
		assert.equal(tavilyRequest.include_answer, false);
		assert.equal(tavilyRequest.max_results, 1);
		assert.deepEqual(searchResult.details, { count: 1 });
		assert.equal(searchResult.content[0].text,
			"- Example — https://example.com\n  Snippet: first second");
		assert.doesNotMatch(searchResult.content[0].text, /provider-generated answer/);

		process.env.EXA_API_KEY = "test-key";
		process.env.JINA_API_KEY = "test-key";
		const fallbackCalls = [];
		global.fetch = async (url) => {
			fallbackCalls.push(String(url));
			if (String(url) === "https://api.exa.ai/search") {
				return new Response(JSON.stringify({ results: [] }), { status: 200 });
			}
			if (String(url) === "https://api.tavily.com/search") {
				return new Response(JSON.stringify({ results: [{ title: "Fallback", url: "https://fallback.example", content: "found" }] }), { status: 200 });
			}
			throw new Error(`Unexpected provider: ${url}`);
		};
		const emptyFallback = await search.execute("test", { query: "test" }, undefined, undefined);
		assert.equal(emptyFallback.details.count, 1);
		assert.deepEqual(fallbackCalls, ["https://api.exa.ai/search", "https://api.tavily.com/search"]);

		global.fetch = async (url) => {
			if (String(url) === "https://s.jina.ai/test") {
				return new Response(JSON.stringify({ data: [] }), { status: 200 });
			}
			return new Response(JSON.stringify({ results: [] }), { status: 200 });
		};
		const emptySearch = await search.execute("test", { query: "test" }, undefined, undefined);
		assert.equal(emptySearch.content[0].text, "No results found.");
		assert.deepEqual(emptySearch.details, { count: 0 });
		delete process.env.EXA_API_KEY;
		delete process.env.JINA_API_KEY;

		const longResultUrl = `https://example.com/${"x".repeat(60 * 1024)}`;
		global.fetch = async () => new Response(JSON.stringify({
			results: [{ title: "Example", url: longResultUrl, content: "large URL" }],
		}), { status: 200, headers: { "content-type": "application/json" } });
		const truncatedSearch = await search.execute("test", { query: "test" }, undefined, undefined);
		const searchSpillPath = spillPathOf(truncatedSearch.content[0].text);
		assert.ok(searchSpillPath);
		assert.equal(truncatedSearch.details.truncation.truncated, true);
		assert.equal(truncatedSearch.details.fullOutputPath, searchSpillPath);
		assert.equal(readFileSync(searchSpillPath, "utf8"), `- Example — ${longResultUrl}\n  Snippet: large URL`);
		rmSync(dirname(searchSpillPath), { recursive: true });

		let bodyPulls = 0;
		let bodyCancelled = false;
		global.fetch = async (url) => String(url) === "https://api.tavily.com/search"
			? new Response(new ReadableStream({
				pull(controller) {
					bodyPulls += 1;
					if (bodyPulls <= 12) controller.enqueue(new Uint8Array(256 * 1024).fill(0x78));
					else controller.close();
				},
				cancel() {
					bodyCancelled = true;
				},
			}), { status: 200, headers: { "content-type": "application/json" } })
			: new Response("provider unavailable", { status: 503 });
		await assert.rejects(search.execute("test", { query: "test" }, undefined, undefined));
		assert.ok(bodyPulls < 12, `provider body stopped early after ${bodyPulls} chunks`);
		assert.equal(bodyCancelled, true);

		global.fetch = async () => new Response("provider\u001b\n  unavailable\u0007", { status: 503 });
		const searchProviderError = await search.execute("test", { query: "test" }, undefined, undefined)
			.then(() => null, (error) => error);
		assert.equal(searchProviderError.message, "Web search failed:\n- Tavily: HTTP 503: provider unavailable");

		delete process.env.TAVILY_API_KEY;
		const missingProvidersError = await search.execute("test", { query: "test" }, undefined, undefined)
			.then(() => null, (error) => error);
		assert.equal(missingProvidersError.message, "Web search failed:\n- No search providers configured");

		const fetchProviderError = await fetchTool.execute("test", { url: "https://example.com" }, undefined, undefined)
			.then(() => null, (error) => error);
		assert.match(fetchProviderError.message, /^Web fetch failed:\n(?:- Exa: HTTP 503\n)?- Jina: HTTP 503$/);

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
		assert.ok(oversizedSearchError.message.split("\n").slice(1).every((line) => line.length <= 210));
		assert.equal(spillPathOf(oversizedSearchError.message), undefined);

		const oversizedUrlError = await fetchTool.execute(
			"test",
			{ url: `https://[${"x".repeat(60_000)}` },
			undefined,
			undefined,
		).then(() => null, (error) => error);
		assert.ok(oversizedUrlError instanceof Error);
		assert.equal(oversizedUrlError.message, "Web fetch failed: Invalid URL");

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
		for (const [name, value] of Object.entries({ EXA_API_KEY: originalKeys.exa, JINA_API_KEY: originalKeys.jina, TAVILY_API_KEY: originalKeys.tavily })) {
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
