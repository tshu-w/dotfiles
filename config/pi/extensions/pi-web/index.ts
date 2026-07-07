/**
 * pi-web — Web search and fetch for Pi.
 *
 * Search: Exa → Tavily → Exa MCP → Jina Search (uses whichever keys are available).
 * Fetch: Exa contents → direct HTTP → Jina Reader.
 *
 * Tools:
 *   web_search — search the web via Exa, return sources + snippets
 *   web_fetch  — fetch a URL as readable text/markdown, with optional pattern filtering
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

// Agent dir first; legacy ~/.pi path kept as fallback.
const CONFIG_PATHS = [join(getAgentDir(), "web-search.json"), `${homedir()}/.pi/web-search.json`];
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_SEARCH_URL = "https://s.jina.ai/";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_MAX_CHARS = 30_000;
const MAX_NUM_RESULTS = 10;
const MAX_FETCH_CHARS = 80_000;
const DIRECT_FETCH_MAX_BYTES = 2_000_000;

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	publishedDate?: string;
}

interface SearchResponse {
	results: SearchResult[];
	answer: string;
}

interface FetchResult {
	title: string;
	content: string;
	error: string | null;
}

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

interface WebConfig {
	exaApiKey?: unknown;
	jinaApiKey?: unknown;
	tavilyApiKey?: unknown;
}

let cachedConfig: WebConfig | null = null;

function loadConfig(): WebConfig {
	if (cachedConfig) return cachedConfig;
	for (const path of CONFIG_PATHS) {
		if (!existsSync(path)) continue;
		try {
			cachedConfig = JSON.parse(readFileSync(path, "utf-8")) as WebConfig;
			return cachedConfig;
		} catch { /* try next */ }
	}
	cachedConfig = {};
	return cachedConfig;
}

function getExaKey(): string | null {
	const envKey = process.env.EXA_API_KEY?.trim();
	if (envKey) return envKey;
	const cfg = loadConfig();
	return typeof cfg.exaApiKey === "string" && cfg.exaApiKey.trim() ? cfg.exaApiKey.trim() : null;
}

function getJinaKey(): string | null {
	const envKey = process.env.JINA_API_KEY?.trim();
	if (envKey) return envKey;
	const cfg = loadConfig();
	return typeof cfg.jinaApiKey === "string" && cfg.jinaApiKey.trim() ? cfg.jinaApiKey.trim() : null;
}

function getTavilyKey(): string | null {
	const envKey = process.env.TAVILY_API_KEY?.trim();
	if (envKey) return envKey;
	const cfg = loadConfig();
	return typeof cfg.tavilyApiKey === "string" && cfg.tavilyApiKey.trim() ? cfg.tavilyApiKey.trim() : null;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("abort"));
}

function normalizeUrl(input: string): { url: string; titleFallback: string } {
	const trimmed = input.trim();
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	const parsed = new URL(withScheme);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Only http and https URLs are supported");
	}
	return {
		url: parsed.toString(),
		titleFallback: parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname,
	};
}

function recencyToStartDate(filter: string): string | null {
	const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
	const d = days[filter];
	if (!d) return null;
	return new Date(Date.now() - d * 86_400_000).toISOString();
}

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(Math.floor(value), max));
}

async function exaSearchDirect(
	exaKey: string,
	query: string,
	opts: { numResults: number; domainFilter?: string[]; recencyFilter?: string },
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const startDate = opts.recencyFilter ? recencyToStartDate(opts.recencyFilter) : null;
	const includeDomains = opts.domainFilter?.filter(d => !d.startsWith("-")).map(d => d.trim()).filter(Boolean);
	const excludeDomains = opts.domainFilter?.filter(d => d.startsWith("-")).map(d => d.slice(1).trim()).filter(Boolean);

	const body: Record<string, unknown> = {
		query,
		type: "auto",
		numResults: opts.numResults,
		contents: { text: { maxCharacters: 1500 }, highlights: true },
	};
	if (includeDomains?.length) body.includeDomains = includeDomains;
	if (excludeDomains?.length) body.excludeDomains = excludeDomains;
	if (startDate) body.startPublishedDate = startDate;

	const res = await fetch(EXA_SEARCH_URL, {
		method: "POST",
		headers: { "x-api-key": exaKey, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: requestSignal(signal),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Exa API ${res.status}: ${text.slice(0, 200)}`);
	}

	const data = await res.json() as {
		results?: Array<{ title?: string; url?: string; text?: string; highlights?: string[]; publishedDate?: string }>;
	};

	const results: SearchResult[] = [];
	const answerParts: string[] = [];

	for (const r of data.results ?? []) {
		if (!r.url) continue;
		const highlights = Array.isArray(r.highlights) ? r.highlights.filter(h => typeof h === "string") : [];
		const snippet = highlights.length > 0
			? highlights.join(" … ").slice(0, 500)
			: (r.text ?? "").slice(0, 500);
		const title = r.title || r.url;
		results.push({ title, url: r.url, snippet, publishedDate: r.publishedDate });
		if (snippet) answerParts.push(`${snippet}\nSource: ${title} (${r.url})`);
	}

	return { results, answer: answerParts.join("\n\n") };
}

async function exaSearchMcp(
	query: string,
	opts: { numResults: number; domainFilter?: string[]; recencyFilter?: string },
	signal?: AbortSignal,
): Promise<SearchResponse> {
	let enrichedQuery = query;
	if (opts.domainFilter?.length) {
		for (const d of opts.domainFilter) {
			enrichedQuery += d.startsWith("-") ? ` -site:${d.slice(1)}` : ` site:${d}`;
		}
	}
	if (opts.recencyFilter) {
		const labels: Record<string, string> = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };
		enrichedQuery += ` ${labels[opts.recencyFilter] ?? ""}`;
	}

	const res = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "web_search_exa", arguments: { query: enrichedQuery, numResults: opts.numResults, type: "auto" } },
		}),
		signal: requestSignal(signal),
	});

	if (!res.ok) throw new Error(`Exa MCP ${res.status}: ${(await res.text()).slice(0, 200)}`);

	const body = await res.text();
	const text = parseMcpText(body);
	if (!text) throw new Error("Exa MCP returned empty content");

	const results = parseMcpResults(text);
	const answer = results.map(r => `${r.snippet}\nSource: ${r.title} (${r.url})`).join("\n\n");
	return { results, answer };
}

async function jinaSearch(
	jinaKey: string,
	query: string,
	opts: { numResults: number },
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const res = await fetch(JINA_SEARCH_URL + encodeURIComponent(query), {
		headers: {
			"Accept": "application/json",
			"Authorization": `Bearer ${jinaKey}`,
			"X-Retain-Images": "none",
		},
		signal: requestSignal(signal),
	});

	if (!res.ok) throw new Error(`Jina Search ${res.status}: ${(await res.text()).slice(0, 200)}`);

	const data = await res.json() as {
		data?: Array<{ title?: string; url?: string; content?: string; description?: string }>;
	};

	const results: SearchResult[] = [];
	const answerParts: string[] = [];

	for (const r of (data.data ?? []).slice(0, opts.numResults)) {
		if (!r.url) continue;
		const title = r.title || r.url;
		const snippet = (r.description || r.content || "").slice(0, 500);
		results.push({ title, url: r.url, snippet });
		if (snippet) answerParts.push(`${snippet}\nSource: ${title} (${r.url})`);
	}

	return { results, answer: answerParts.join("\n\n") };
}

async function tavilySearch(
	tavilyKey: string,
	query: string,
	opts: { numResults: number; domainFilter?: string[]; recencyFilter?: string },
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const includeDomains = opts.domainFilter?.filter(d => !d.startsWith("-")).map(d => d.trim()).filter(Boolean);
	const excludeDomains = opts.domainFilter?.filter(d => d.startsWith("-")).map(d => d.slice(1).trim()).filter(Boolean);

	const body: Record<string, unknown> = {
		query,
		max_results: opts.numResults,
		include_answer: true,
		search_depth: "basic",
	};
	if (includeDomains?.length) body.include_domains = includeDomains;
	if (excludeDomains?.length) body.exclude_domains = excludeDomains;
	if (opts.recencyFilter) {
		const days: Record<string, string> = { day: "d", week: "w", month: "m", year: "y" };
		body.time_range = days[opts.recencyFilter] ?? undefined;
	}

	const res = await fetch(TAVILY_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${tavilyKey}`,
		},
		body: JSON.stringify(body),
		signal: requestSignal(signal),
	});

	if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);

	const data = await res.json() as {
		answer?: string;
		results?: Array<{ title?: string; url?: string; content?: string }>;
	};

	const results: SearchResult[] = [];
	const answerParts: string[] = [];

	for (const r of data.results ?? []) {
		if (!r.url) continue;
		const title = r.title || r.url;
		const snippet = (r.content || "").slice(0, 500);
		results.push({ title, url: r.url, snippet });
		if (snippet) answerParts.push(`${snippet}\nSource: ${title} (${r.url})`);
	}

	const sources = answerParts.join("\n\n");
	const answer = data.answer && sources ? `${data.answer}\n\n---\n\nSources:\n${sources}` : (data.answer || sources);
	return { results, answer };
}

async function searchWithFallback(
	query: string,
	opts: { numResults: number; domainFilter?: string[]; recencyFilter?: string },
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const errors: string[] = [];

	// 1. Exa direct API
	const exaKey = getExaKey();
	if (exaKey) {
		try { return await exaSearchDirect(exaKey, query, opts, signal); } catch (err) {
			if (isAbortError(err)) throw err;
			errors.push(`Exa: ${err instanceof Error ? err.message : err}`);
		}
	}

	// 2. Tavily
	const tavilyKey = getTavilyKey();
	if (tavilyKey) {
		try { return await tavilySearch(tavilyKey, query, opts, signal); } catch (err) {
			if (isAbortError(err)) throw err;
			errors.push(`Tavily: ${err instanceof Error ? err.message : err}`);
		}
	}

	// 3. Exa MCP (free, no key)
	try { return await exaSearchMcp(query, opts, signal); } catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Exa MCP: ${err instanceof Error ? err.message : err}`);
	}

	// 4. Jina Search
	const jinaKey = getJinaKey();
	if (jinaKey) {
		try { return await jinaSearch(jinaKey, query, opts, signal); } catch (err) {
			if (isAbortError(err)) throw err;
			errors.push(`Jina: ${err instanceof Error ? err.message : err}`);
		}
	}

	throw new Error(`All search providers failed:\n${errors.join("\n")}`);
}

function parseMcpText(body: string): string | null {
	for (const line of body.split("\n").filter(l => l.startsWith("data:"))) {
		try {
			const parsed = JSON.parse(line.slice(5).trim()) as { result?: { content?: Array<{ type?: string; text?: string }> } };
			const text = parsed.result?.content?.find(c => c.type === "text")?.text;
			if (text?.trim()) return text;
		} catch {}
	}

	try {
		const parsed = JSON.parse(body) as { result?: { content?: Array<{ type?: string; text?: string }> } };
		return parsed.result?.content?.find(c => c.type === "text")?.text || null;
	} catch {}
	return null;
}

function parseMcpResults(text: string): SearchResult[] {
	const blocks = text.split(/(?=^Title: )/m).filter(b => b.trim());
	return blocks.map(block => {
		const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
		const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
		let content = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) content = block.slice(textStart + 7).trim();
		else {
			const hlMatch = block.match(/\nHighlights:\s*\n/);
			if (hlMatch?.index != null) content = block.slice(hlMatch.index + hlMatch[0].length).trim();
		}
		content = content.replace(/\n---\s*$/, "").trim();
		return { title: title || url, url, snippet: content.slice(0, 500) };
	}).filter(r => r.url);
}

async function fetchUrl(inputUrl: string, maxChars: number, signal?: AbortSignal): Promise<FetchResult> {
	let normalized: { url: string; titleFallback: string };
	try {
		normalized = normalizeUrl(inputUrl);
	} catch (err) {
		return { title: inputUrl, content: "", error: err instanceof Error ? err.message : String(err) };
	}

	const exaKey = getExaKey();
	if (exaKey) {
		try {
			const result = await exaGetContents(normalized.url, exaKey, maxChars, signal);
			if (result) return result;
		} catch (err) {
			if (isAbortError(err)) throw err;
		}
	}

	try {
		const result = await directFetch(normalized.url, normalized.titleFallback, maxChars, signal);
		if (result) return result;
	} catch (err) {
		if (isAbortError(err)) throw err;
	}

	return jinaFetch(normalized.url, normalized.titleFallback, maxChars, signal);
}

async function exaGetContents(url: string, exaKey: string, maxChars: number, signal?: AbortSignal): Promise<FetchResult | null> {
	const res = await fetch(EXA_CONTENTS_URL, {
		method: "POST",
		headers: { "x-api-key": exaKey, "Content-Type": "application/json" },
		body: JSON.stringify({ urls: [url], text: { maxCharacters: maxChars } }),
		signal: requestSignal(signal),
	});
	if (!res.ok) return null;

	const data = await res.json() as { results?: Array<{ title?: string; text?: string }> };
	const first = data.results?.[0];
	if (!first?.text || first.text.length < 50) return null;
	return { title: first.title || url, content: first.text.slice(0, maxChars), error: null };
}

async function directFetch(url: string, titleFallback: string, maxChars: number, signal?: AbortSignal): Promise<FetchResult | null> {
	const res = await fetch(url, {
		headers: { "User-Agent": "Mozilla/5.0 (compatible; PiBot/1.0)", "Accept": "text/html,text/plain,application/json,text/markdown" },
		signal: requestSignal(signal),
		redirect: "follow",
	});
	if (!res.ok) return null;

	const contentLength = Number.parseInt(res.headers.get("content-length") || "0", 10);
	if (Number.isFinite(contentLength) && contentLength > DIRECT_FETCH_MAX_BYTES) return null;

	const contentType = res.headers.get("content-type") ?? "";
	const text = await readBodyLimited(res, DIRECT_FETCH_MAX_BYTES);

	if (contentType.includes("text/plain") || contentType.includes("application/json") || contentType.includes("text/markdown")) {
		return { title: titleFallback, content: text.slice(0, maxChars), error: null };
	}

	if (!contentType.includes("text/html")) return null;

	const title = decodeHtmlEntities(text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || titleFallback);
	let body = text
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<nav[\s\S]*?<\/nav>/gi, "")
		.replace(/<header[\s\S]*?<\/header>/gi, "")
		.replace(/<footer[\s\S]*?<\/footer>/gi, "")
		.replace(/<(h[1-6]|p|div|section|article|li|br|tr|blockquote)\b[^>]*>/gi, "\n")
		.replace(/<\/\s*(h[1-6]|p|div|section|article|li|tr|blockquote)>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	body = decodeHtmlEntities(body)
		.split("\n")
		.map(line => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join("\n");

	if (body.length < 100) return null;
	return { title, content: body.slice(0, maxChars), error: null };
}

async function jinaFetch(url: string, titleFallback: string, maxChars: number, signal?: AbortSignal): Promise<FetchResult> {
	const res = await fetch(JINA_READER_BASE + url, {
		headers: { "Accept": "text/markdown", "X-No-Cache": "true" },
		signal: requestSignal(signal),
	});

	if (!res.ok) return { title: titleFallback, content: "", error: `Fetch failed (Jina ${res.status})` };

	const text = await readBodyLimited(res, DIRECT_FETCH_MAX_BYTES);
	const contentStart = text.indexOf("Markdown Content:");
	const markdown = contentStart >= 0 ? text.slice(contentStart + "Markdown Content:".length).trim() : text.trim();

	if (markdown.length < 50 || markdown.startsWith("Loading...") || markdown.startsWith("Please enable JavaScript")) {
		return { title: titleFallback, content: "", error: "Page requires JavaScript rendering" };
	}

	const title = markdown.match(/^#\s+(.+)/m)?.[1]?.trim() || titleFallback;
	return { title, content: markdown.slice(0, maxChars), error: null };
}

async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return res.text();

	const decoder = new TextDecoder();
	let result = "";
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				result += decoder.decode();
				break;
			}
			result += decoder.decode(value, { stream: true });
			if (result.length >= maxBytes) {
				result = result.slice(0, maxBytes);
				truncated = true;
				await reader.cancel("response body truncated");
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return result;
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function findInContent(content: string, pattern: string, contextChars = 200): string {
	const normalizedPattern = pattern.trim();
	if (!normalizedPattern) return "Pattern is empty.";

	const lower = content.toLowerCase();
	const patLower = normalizedPattern.toLowerCase();
	const matches: string[] = [];
	let start = 0;
	let lastTo = -1;

	while (matches.length < 10) {
		const idx = lower.indexOf(patLower, start);
		if (idx < 0) break;
		const from = Math.max(0, idx - contextChars);
		const to = Math.min(content.length, idx + normalizedPattern.length + contextChars);
		if (from > lastTo) {
			matches.push(`...${content.slice(from, to)}...`);
			lastTo = to;
		}
		start = idx + normalizedPattern.length;
	}

	if (matches.length === 0) return `Pattern "${normalizedPattern}" not found in page.`;
	return `Found ${matches.length} match(es) for "${normalizedPattern}":\n\n${matches.join("\n\n---\n\n")}`;
}

function formatSearchResults(results: SearchResult[]): string {
	return results.map((r, i) => {
		const snippet = r.snippet ? `\n${r.snippet}` : "";
		return `${i + 1}. ${r.title}\n${r.url}${snippet}`;
	}).join("\n\n");
}

export default function (pi: ExtensionAPI) {
	const searchToolName = "web_search";

	pi.registerTool({
		name: searchToolName,
		label: "Web Search",
		description: "Search the web via Exa, Tavily, Exa MCP, or Jina Search. Returns sources with snippets and uses whichever API keys are available.",
		promptSnippet: "Use for web research. Returns sources and snippets.",
		promptGuidelines: [
			`Use ${searchToolName} for questions about current events, recent releases, or anything beyond training data.`,
			"Use web_fetch to read a specific URL in full after finding it via search.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			numResults: Type.Optional(Type.Number({ description: "Number of results (default: 5, max: 10)" })),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
			recencyFilter: Type.Optional(StringEnum(["day", "week", "month", "year"], { description: "Filter by recency" })),
		}),

		async execute(_id, params, signal, onUpdate) {
			const numResults = clampPositiveInt(params.numResults, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
			const opts = { numResults, domainFilter: params.domainFilter, recencyFilter: params.recencyFilter };
			onUpdate?.({ content: [{ type: "text", text: `Searching: ${params.query}` }], details: { phase: "searching" } });

			try {
				const response = await searchWithFallback(params.query, opts, signal);

				if (response.results.length === 0) {
					return { content: [{ type: "text", text: "No results found." }], details: { query: params.query, count: 0 } };
				}

				return {
					content: [{ type: "text", text: response.answer || formatSearchResults(response.results) }],
					details: { query: params.query, count: response.results.length, toolName: searchToolName },
				};
			} catch (err) {
				if (isAbortError(err) || signal?.aborted) {
					return { content: [{ type: "text", text: "Search cancelled." }], details: { aborted: true } };
				}
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Search error: ${msg}` }], details: { error: msg } };
			}
		},

		renderCall(args, theme) {
			const { query } = args as { query?: string };
			const display = !query ? "(no query)" : query.length > 60 ? query.slice(0, 57) + "..." : query;
			return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as { count?: number; error?: string; aborted?: boolean; phase?: string };
			if (isPartial) return new Text(theme.fg("accent", details?.phase || "searching"), 0, 0);
			if (details?.aborted) return new Text(theme.fg("muted", "cancelled"), 0, 0);
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const summary = theme.fg("success", `${details?.count ?? 0} sources`);
			if (!expanded) return new Text(summary, 0, 0);
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			const preview = text.length > 400 ? text.slice(0, 400) + "..." : text;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "Fetch a URL and extract readable content. Optionally search within the page using pattern. Fallback chain: Exa contents → direct fetch → Jina Reader.",
		promptSnippet: "Use to read a specific URL. Supports pattern for in-page search.",
		promptGuidelines: [
			"Use web_fetch when the user provides a URL or after search finds a relevant page.",
			"Use web_fetch with pattern to find specific information within a long page, similar to Ctrl+F.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			maxChars: Type.Optional(Type.Number({ description: "Max characters to return (default: 30000, max: 80000)" })),
			pattern: Type.Optional(Type.String({ description: "Search for this text within the page (case-insensitive)" })),
		}),

		async execute(_id, params, signal, onUpdate) {
			const maxChars = clampPositiveInt(params.maxChars, DEFAULT_MAX_CHARS, MAX_FETCH_CHARS);
			onUpdate?.({ content: [{ type: "text", text: `Fetching: ${params.url}` }], details: { phase: "fetching" } });

			try {
				const result = await fetchUrl(params.url, maxChars, signal);
				if (result.error) {
					return { content: [{ type: "text", text: `Error: ${result.error}` }], details: { url: params.url, error: result.error } };
				}

				const output = params.pattern
					? findInContent(result.content, params.pattern)
					: `# ${result.title}\n\n${result.content}`;

				return {
					content: [{ type: "text", text: output }],
					details: { url: params.url, title: result.title, chars: result.content.length, pattern: params.pattern },
				};
			} catch (err) {
				if (isAbortError(err) || signal?.aborted) {
					return { content: [{ type: "text", text: "Fetch cancelled." }], details: { url: params.url, aborted: true } };
				}
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text", text: `Fetch error: ${msg}` }], details: { url: params.url, error: msg } };
			}
		},

		renderCall(args, theme) {
			const { url, pattern } = args as { url?: string; pattern?: string };
			const display = !url ? "(no URL)" : url.length > 55 ? url.slice(0, 52) + "..." : url;
			let text = theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display);
			if (pattern) text += theme.fg("dim", ` [find: "${pattern}"]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as { title?: string; chars?: number; error?: string; pattern?: string; aborted?: boolean; phase?: string };
			if (isPartial) return new Text(theme.fg("accent", details?.phase || "fetching"), 0, 0);
			if (details?.aborted) return new Text(theme.fg("muted", "cancelled"), 0, 0);
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			let summary = theme.fg("success", details?.title || "Fetched") + theme.fg("muted", ` (${details?.chars ?? 0} chars)`);
			if (details?.pattern) summary += theme.fg("accent", ` [find: "${details.pattern}"]`);
			if (!expanded) return new Text(summary, 0, 0);
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			const preview = text.length > 400 ? text.slice(0, 400) + "..." : text;
			return new Text(summary + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});
}
