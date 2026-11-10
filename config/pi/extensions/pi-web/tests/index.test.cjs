const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync, realpathSync, rmSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { after, afterEach, before, beforeEach, test } = require("node:test");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

const KEYS = ["EXA_API_KEY", "TAVILY_API_KEY", "JINA_API_KEY"];
const savedKeys = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const originalFetch = global.fetch;
let extension;
let MAX_BYTES;
let MAX_LINES;

before(async () => {
	const jiti = createJiti(__filename, {
		interopDefault: true,
		alias: {
			"@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js`,
			"@earendil-works/pi-ai/compat": `${PI_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
			"@earendil-works/pi-tui": `${PI_PACKAGE}/node_modules/@earendil-works/pi-tui/dist/index.js`,
			typebox: `${PI_PACKAGE}/node_modules/typebox/build/index.mjs`,
		},
	});
	({ DEFAULT_MAX_BYTES: MAX_BYTES, DEFAULT_MAX_LINES: MAX_LINES } = await jiti.import(`${PI_PACKAGE}/dist/index.js`));
	extension = await jiti.import("../index.ts");
});
beforeEach(() => {
	for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
	global.fetch = originalFetch;
});
after(() => {
	for (const key of KEYS) {
		if (savedKeys[key] === undefined) delete process.env[key];
		else process.env[key] = savedKeys[key];
	}
});

// Each test loads its own extension instance, so caches never leak between tests.
function load() {
	const tools = new Map();
	const handlers = new Map();
	extension.default({ registerTool(tool) { tools.set(tool.name, tool); }, on(event, handler) { handlers.set(event, handler); } });
	const session = (id) => ({ sessionManager: { getSessionId: () => id } });
	return {
		tools,
		search: (params, signal) => tools.get("web_search").execute("id", params, signal, undefined, session("a")),
		fetch: (params, signal, sessionId = "a") => tools.get("web_fetch").execute("id", params, signal, undefined, session(sessionId)),
		shutdown: () => handlers.get("session_shutdown")({}, session("a")),
	};
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const textOf = (result) => result.content[0].text;
const failure = (promise) => promise.then(() => assert.fail("expected a tool error"), (error) => error.message);

// Serves one page through Exa and returns a counter of provider requests.
function servePage(text, title = "Page") {
	process.env.EXA_API_KEY = "key";
	let requests = 0;
	global.fetch = async () => {
		requests++;
		return json({ results: [{ title: `${title} ${requests}`, text }] });
	};
	return () => requests;
}

const excerpts = Array.from({ length: 12 }, (_, i) => `${"x".repeat(450)}Needle excerpt-${i}${"x".repeat(450)}`).join("\n");

test("search returns sources from each provider", async () => {
	const { search } = load();
	for (const [key, body, expected] of [
		["EXA_API_KEY", { results: [{ title: "Exa", url: "https://a.example", highlights: ["one", "two"] }] }, "- Exa — https://a.example\n  Snippet: one … two"],
		// Terminal control characters from providers never reach the output.
		["TAVILY_API_KEY", { results: [{ title: "Tav\u001bily", url: "https://b.example", content: "first\u001b\nsecond\u0007" }] }, "- Tavily — https://b.example\n  Snippet: first second"],
		["JINA_API_KEY", { data: [{ title: "Jina", url: "https://c.example", description: "found" }] }, "- Jina — https://c.example\n  Snippet: found"],
	]) {
		process.env[key] = "key";
		global.fetch = async () => json(body);
		const result = await search({ query: "q" });
		assert.equal(textOf(result), expected);
		assert.deepEqual(result.details, { count: 1 });
		delete process.env[key];
	}
});

test("search falls back past failing and empty providers", async () => {
	const { search } = load();
	for (const key of KEYS) process.env[key] = "key";
	const hosts = [];
	global.fetch = async (url) => {
		const host = new URL(url).hostname;
		hosts.push(host);
		if (host === "api.exa.ai") return new Response("down", { status: 503 });
		if (host === "api.tavily.com") return json({ results: [] });
		return json({ data: [{ title: "Fallback", url: "https://fallback.example", description: "found" }] });
	};
	assert.match(textOf(await search({ query: "q" })), /^- Fallback — /);
	assert.deepEqual(hosts, ["api.exa.ai", "api.tavily.com", "s.jina.ai"]);

	global.fetch = async () => json({ results: [], data: [] });
	const empty = await search({ query: "q" });
	assert.equal(textOf(empty), "No results found.");
	assert.deepEqual(empty.details, { count: 0 });
});

test("search reports provider failures, missing keys and cancellation", async () => {
	const { search } = load();
	assert.match(await failure(search({ query: "q" })), /No search providers configured\. Set EXA_API_KEY, TAVILY_API_KEY, or JINA_API_KEY\./);

	process.env.TAVILY_API_KEY = "key";
	global.fetch = async () => new Response("provider\u001b\n  unavailable", { status: 503 });
	assert.equal(await failure(search({ query: "q" })), "Web search failed:\n- Tavily: HTTP 503: provider unavailable");

	global.fetch = async () => { throw new Error("e".repeat(60 * 1024)); };
	assert.ok((await failure(search({ query: "q" }))).length < 1000, "provider errors stay bounded");

	const aborted = new AbortController();
	aborted.abort();
	assert.equal(await failure(search({ query: "q" }, aborted.signal)), "Search cancelled.");
});

test("fetch returns readable content from Exa and falls back to Jina", async () => {
	const { fetch } = load();
	process.env.EXA_API_KEY = "key";
	const urls = [];
	global.fetch = async (url) => {
		urls.push(String(url));
		return json({ results: [{ title: "Short", text: "OK" }] });
	};
	const viaExa = await fetch({ url: "one.example" });
	assert.equal(textOf(viaExa), "Title: Short\n\nOK");
	assert.deepEqual(viaExa.details, { title: "Short", chars: 2 });

	global.fetch = async (url) => {
		urls.push(String(url));
		return String(url).startsWith("https://r.jina.ai/")
			? new Response("Title: Reader\n\nMarkdown Content:\n# Body\u001b\n\ntext")
			: new Response("down", { status: 503 });
	};
	assert.equal(textOf(await fetch({ url: "https://two.example" })), "Title: Reader\n\n# Body\n\ntext");
	assert.deepEqual(urls, ["https://api.exa.ai/contents", "https://api.exa.ai/contents", "https://r.jina.ai/https://two.example/"]);
});

test("fetch retries Jina anonymously when its key is rejected", async () => {
	const { fetch } = load();
	process.env.JINA_API_KEY = "key";
	const authorizations = [];
	global.fetch = async (_url, init) => {
		authorizations.push(init.headers.Authorization);
		return init.headers.Authorization ? new Response("quota exhausted", { status: 402 }) : new Response("anonymous body");
	};
	assert.match(textOf(await fetch({ url: "https://example.net" })), /anonymous body$/);
	assert.deepEqual(authorizations, ["Bearer key", undefined]);
});

test("pattern search pages through excerpts of one fetched copy", async () => {
	const { fetch } = load();
	const requests = servePage(excerpts);
	const args = { url: "https://example.com", pattern: "needle" };

	const first = await fetch({ ...args, limit: 5 });
	assert.match(textOf(first), /^Title: Page 1\n\n5 of 12 matching excerpts for "needle"\n\n\.\.\.\n/);
	assert.match(textOf(first), /\n\.\.\.\n\n\[7 more results\. Use offset=5 to continue\.\]$/);
	assert.deepEqual(first.details, { title: "Page 1", chars: excerpts.length, total: 12, count: 5, nextOffset: 5 });

	const second = await fetch({ ...args, offset: 5, limit: 5 });
	assert.match(textOf(second), /excerpt-5/);
	assert.doesNotMatch(textOf(second), /excerpt-4/);

	const last = await fetch({ ...args, offset: 10 });
	assert.equal(last.details.count, 2);
	assert.doesNotMatch(textOf(last), /to continue/);

	const beyond = await fetch({ ...args, offset: 99 });
	assert.match(textOf(beyond), /No matching excerpts at offset 99 \(total: 12\)\.$/);
	assert.deepEqual([beyond.details.count, beyond.details.total], [0, 12]);

	const absent = await fetch({ ...args, pattern: "absent" });
	assert.match(textOf(absent), /No matches for "absent"\.$/);
	assert.equal(absent.details.total, 0);
	assert.equal(requests(), 1, "every page and pattern reads the same fetched copy");
});

test("an expired copy keeps serving later pages and is refreshed only from offset 0", async () => {
	const { fetch } = load();
	const requests = servePage(excerpts);
	const args = { url: "https://ttl.example", pattern: "needle" };
	const clock = Date.now;
	let now = 1000;
	Date.now = () => now;
	try {
		await fetch(args);
		now += 6 * 60_000;
		const laterPage = await fetch({ ...args, offset: 5 });
		assert.equal(laterPage.details.title, "Page 1");
		assert.match(textOf(laterPage), /excerpt-5/);
		assert.equal((await fetch(args)).details.title, "Page 2");
		assert.equal(requests(), 2);
	} finally {
		Date.now = clock;
	}
});

test("parallel calls share one fetch; sessions and shutdown do not share content", async () => {
	const { fetch, shutdown } = load();
	process.env.EXA_API_KEY = "key";
	const pending = [];
	global.fetch = () => new Promise((resolve) => pending.push(resolve));
	const args = { url: "https://shared.example", pattern: "needle", limit: 1 };
	const calls = [fetch(args), fetch({ ...args, url: " SHARED.example:443/ " })];
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pending.length, 1);
	pending[0](json({ results: [{ title: "Shared", text: excerpts }] }));
	const [one, two] = await Promise.all(calls);
	assert.deepEqual(one, two);

	const requests = servePage("needle elsewhere", "Other");
	assert.equal((await fetch(args, undefined, "b")).details.total, 1);
	assert.equal((await fetch(args)).details.total, 12, "the first session keeps its own copy");
	assert.equal(requests(), 1);
	await shutdown();
	await fetch({ ...args, offset: 1 });
	assert.equal(requests(), 2, "shutdown clears the cache");
});

test("every match appears on some page, and no page is truncated", async () => {
	const { fetch } = load();
	const id = (i) => String(i).padStart(3, "0");
	for (const [name, text, limit] of [
		// Excerpts too long for one page: the page shrinks instead of cutting an excerpt.
		["tall", Array.from({ length: 30 }, (_, i) => `${"\n".repeat(250)}${id(i)}:needle${"\n".repeat(250)}`).join(""), 100],
		// Matches closer together than the excerpt context.
		["dense", Array.from({ length: 30 }, (_, i) => `${id(i)}:needle${"x".repeat(90)}`).join(""), 2],
	]) {
		servePage(text);
		const args = { url: `https://${name}.example`, pattern: "needle", limit };
		const seen = new Set();
		let page = await fetch(args);
		while (true) {
			assert.equal(page.details.truncation, undefined);
			assert.ok(page.details.count > 0);
			for (const match of textOf(page).matchAll(/(\d{3}):needle/g)) seen.add(Number(match[1]));
			if (page.details.nextOffset === undefined) break;
			page = await fetch({ ...args, offset: page.details.nextOffset });
		}
		assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i), name);
	}
});

test("long pages are truncated with a notice and the full output path", async () => {
	const { fetch } = load();
	for (const [name, page] of [
		["lines", Array.from({ length: MAX_LINES + 10 }, (_, i) => `line ${i}`).join("\n")],
		["bytes", "中".repeat(MAX_BYTES)],
	]) {
		servePage(page);
		const result = await fetch({ url: `https://${name}.example` });
		const path = textOf(result).match(/\. Full output: (.+)\]$/)?.[1];
		assert.equal(result.details.truncation.truncated, true);
		assert.ok(result.details.truncation.outputBytes <= MAX_BYTES);
		assert.ok(result.details.truncation.outputLines <= MAX_LINES);
		assert.equal(result.details.fullOutputPath, path);
		assert.equal(readFileSync(path, "utf8"), `Title: Page 1\n\n${page}`);
		rmSync(dirname(path), { recursive: true });
	}
});

test("fetch rejects unsupported input and reports provider failures", async () => {
	const { fetch } = load();
	assert.equal(await failure(fetch({ url: "file:///tmp/test" })), "Web fetch failed: Only http and https URLs are supported");
	assert.equal(await failure(fetch({ url: "https://example.com", pattern: "one\ntwo" })), "Pattern must not contain control characters.");
	assert.equal(await failure(fetch({ url: "https://example.com", limit: 1 })), "limit and offset require pattern.");

	global.fetch = async () => new Response("down", { status: 503 });
	assert.equal(await failure(fetch({ url: "https://example.com" })), "Web fetch failed:\n- Jina: HTTP 503");

	let cancelled = false;
	global.fetch = async () => new Response(new ReadableStream({
		pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
		cancel() { cancelled = true; },
	}));
	assert.match(await failure(fetch({ url: "https://huge.example" })), /Jina: Response body exceeds \d+ bytes\./);
	assert.equal(cancelled, true, "an oversized response is abandoned, not read to the end");
});

test("a cancelled fetch fails and is not cached", async () => {
	const { fetch } = load();
	const requests = servePage("fresh");
	const provider = global.fetch;
	const abort = new AbortController();
	global.fetch = async () => {
		abort.abort();
		return provider();
	};
	assert.equal(await failure(fetch({ url: "https://cancel.example" }, abort.signal)), "Fetch cancelled.");
	global.fetch = provider;
	assert.equal(textOf(await fetch({ url: "https://cancel.example" })), "Title: Page 2\n\nfresh");
	assert.equal(requests(), 2);
});

test("calls and results render in Pi's style", () => {
	const { tools } = load();
	const styles = [];
	const theme = { bold: (text) => `<b>${text}</b>`, fg: (color, text) => { styles.push([color, text]); return text; } };
	const lines = (component) => component.render(1000).map((line) => line.trimEnd()).join("\n");
	const render = (tool, result, args, { expanded = false, isError = false } = {}) => lines(tools.get(tool)
		.renderResult(result, { expanded, isPartial: false }, theme, { args, isError, keyText: () => "ctrl+y" }));
	const fetchArgs = { url: "https://example.com", pattern: "needle" };

	const call = '<b>web_fetch</b>(url="https://example.com", pattern="needle")';
	assert.equal(lines(tools.get("web_fetch").renderCall(fetchArgs, theme, { isPartial: true })), call);
	assert.equal(lines(tools.get("web_fetch").renderCall(fetchArgs, theme, { isPartial: false })), `${call}\n`);

	const sources = { content: [{ type: "text", text: "- Example — https://example.com\n  Snippet: notes" }], details: { count: 1 } };
	assert.equal(render("web_search", sources, { query: "q" }), "- Example — https://example.com\n... (1 more lines, ctrl+y to expand)");

	const page = { content: [{ type: "text", text: "Title: Example\n\nbody" }], details: { title: "Example", chars: 4, total: 12, count: 5, nextOffset: 5 } };
	assert.equal(render("web_fetch", page, fetchArgs),
		"Example (4 chars, 5 of 12 matching excerpts)\n... (3 more lines, ctrl+y to expand)\n[7 more results. Use offset=5 to continue.]");

	const notice = "[Showing lines 1-20 of 100. Full output: /tmp/web.txt]";
	const truncated = { content: [{ type: "text", text: `body\n\n${notice}` }], details: { title: "Example", truncation: { truncated: true } } };
	assert.equal(render("web_fetch", truncated, fetchArgs, { expanded: true }), `body\n\n${notice}`);
	assert.ok(styles.some(([color, text]) => color === "warning" && text === notice));

	const failed = { content: [{ type: "text", text: "Web fetch failed: Invalid URL" }] };
	assert.equal(render("web_fetch", failed, fetchArgs, { isError: true }), "Web fetch failed: Invalid URL");
});
