import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export function getSessionsDir(): string {
	return path.join(getAgentDir(), "sessions");
}

/**
 * Walk the sessions directory and return all .jsonl files sorted newest-first by mtime.
 */
function listSessionFiles(): Array<{ file: string; mtime: number }> {
	const sessionsDir = getSessionsDir();
	if (!fs.existsSync(sessionsDir)) return [];

	const all: Array<{ file: string; mtime: number }> = [];
	for (const subdir of fs.readdirSync(sessionsDir)) {
		const subdirPath = path.join(sessionsDir, subdir);
		let stat: fs.Stats;
		try { stat = fs.statSync(subdirPath); } catch { continue; }
		if (!stat.isDirectory()) continue;
		for (const file of fs.readdirSync(subdirPath)) {
			if (!file.endsWith(".jsonl")) continue;
			const fullPath = path.join(subdirPath, file);
			try {
				const fstat = fs.statSync(fullPath);
				all.push({ file: fullPath, mtime: fstat.mtimeMs });
			} catch { /* skip */ }
		}
	}
	all.sort((a, b) => b.mtime - a.mtime);
	return all;
}

export function getEnabledModels(cwd?: string): string[] {
	let global: string[] | undefined;
	let project: string[] | undefined;
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf-8"));
		global = Array.isArray(raw.enabledModels) ? raw.enabledModels : undefined;
	} catch { /* no global settings */ }
	if (cwd) {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf-8"));
			project = Array.isArray(raw.enabledModels) ? raw.enabledModels : undefined;
		} catch { /* no project settings */ }
	}
	return project ?? global ?? [];
}

export interface SessionScanResult {
	file: string;
	sessionId: string;
	timestamp: string;
	name?: string;
	firstMessage?: string;
	matchSnippets?: string[];
	cwd?: string;
}

export interface AnchorScanResult {
	sessionFile: string;
	sessionId: string;
	sessionCwd?: string;
	anchorName: string;
	anchorId: string;
	summary: string;
	timestamp: string;
}

export async function scanSessions(
	keyword?: string,
	limit = 10,
	signal?: AbortSignal,
	options?: { scope?: "cwd" | "all"; cwd?: string },
): Promise<SessionScanResult[]> {
	const scope = options?.scope ?? "all";
	const filterCwd = scope === "cwd" ? options?.cwd : undefined;
	const lowerKw = keyword?.toLowerCase();
	const results: SessionScanResult[] = [];

	for (const { file } of listSessionFiles()) {
		if (signal?.aborted || results.length >= limit) break;

		let raw: string;
		try { raw = fs.readFileSync(file, "utf-8"); } catch { continue; }
		if (lowerKw && !raw.toLowerCase().includes(lowerKw)) continue;

		const lines = raw.split("\n");
		let header: any = null;
		let sessionName: string | undefined;
		let firstUserMsg: string | undefined;
		let skip = false;
		let seen = 0;

		for (const line of lines) {
			if (signal?.aborted) break;
			if (!line.trim()) continue;
			seen++;
			if (seen > 50) break;
			if (header && firstUserMsg && sessionName) break;
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }

			if (entry.type === "session") {
				header = entry;
				if (filterCwd && header.cwd !== filterCwd) { skip = true; break; }
			}
			if (entry.type === "session_info" && entry.name) sessionName = entry.name;
			if (!firstUserMsg && entry.type === "message" && entry.message?.role === "user") {
				const content = entry.message.content;
				if (typeof content === "string") firstUserMsg = content.slice(0, 300);
				else if (Array.isArray(content)) {
					for (const c of content) {
						if (c.type === "text") { firstUserMsg = c.text.slice(0, 300); break; }
					}
				}
			}
		}
		if (skip) continue;

		let snippets: string[] | undefined;
		if (lowerKw) {
			snippets = [];
			for (const line of lines) {
				if (snippets.length >= 3) break;
				if (!line.toLowerCase().includes(lowerKw)) continue;
				let entry: any;
				try { entry = JSON.parse(line); } catch { continue; }
				const text = getEntryText(entry);
				const role = entry.type === "message" ? (entry.message?.role ?? entry.type) : entry.type;
				if (!text || !text.toLowerCase().includes(lowerKw)) continue;
				const idx = text.toLowerCase().indexOf(lowerKw);
				const start = Math.max(0, idx - 40);
				const end = Math.min(text.length, idx + lowerKw.length + 60);
				const snippet = (start > 0 ? "..." : "") + text.slice(start, end).replace(/\n/g, " ") + (end < text.length ? "..." : "");
				snippets.push(`[${role}] ${snippet}`);
			}
			if (snippets.length === 0) snippets = undefined;
		}

		results.push({
			file,
			sessionId: header?.id ?? path.basename(file, ".jsonl"),
			timestamp: header?.timestamp ?? "",
			name: sessionName,
			firstMessage: firstUserMsg,
			matchSnippets: snippets,
			cwd: header?.cwd,
		});
	}

	return results;
}

export async function scanAnchors(
	keyword: string,
	scope: "cwd" | "all",
	cwd: string,
	limit = 10,
	signal?: AbortSignal,
): Promise<AnchorScanResult[]> {
	if (limit <= 0) return [];

	const lowerKw = keyword.toLowerCase();
	const results: AnchorScanResult[] = [];
	const timeValue = (ts: string) => {
		const value = Date.parse(ts);
		return Number.isFinite(value) ? value : 0;
	};

	for (const { file, mtime } of listSessionFiles()) {
		if (signal?.aborted) break;

		const cached = loadSessionAnchors(file, mtime);
		if (scope === "cwd" && cached.cwd !== cwd) continue;
		if (cached.anchors.length === 0) continue;

		for (const a of cached.anchors) {
			if (signal?.aborted) break;
			const haystack = `${a.anchorName}\n${a.summary}`.toLowerCase();
			if (!haystack.includes(lowerKw)) continue;
			results.push({
				sessionFile: file,
				sessionId: cached.sessionId ?? "",
				sessionCwd: cached.cwd,
				anchorName: a.anchorName,
				anchorId: a.anchorId,
				summary: a.summary,
				timestamp: a.timestamp,
			});
		}
	}

	results.sort((a, b) => timeValue(b.timestamp) - timeValue(a.timestamp));
	return results.slice(0, limit);
}

// ── Anchor cache ────────────────────────────────────
// Caches parsed anchor entries per session file. Keyed by (file, mtime);
// mtime invalidates naturally when pi's session-manager appends new entries.
// Memory bound: typical session has O(10) anchors × O(hundreds) of sessions.

interface CachedAnchorEntry {
	anchorId: string;
	anchorName: string;
	summary: string;
	timestamp: string;
}

interface CachedSessionAnchors {
	mtime: number;
	sessionId?: string;
	cwd?: string;
	anchors: CachedAnchorEntry[];
}

const _anchorCache = new Map<string, CachedSessionAnchors>();

function loadSessionAnchors(file: string, mtime: number): CachedSessionAnchors {
	const cached = _anchorCache.get(file);
	if (cached && cached.mtime === mtime) return cached;

	let raw: string;
	try { raw = fs.readFileSync(file, "utf-8"); }
	catch {
		const empty: CachedSessionAnchors = { mtime, anchors: [] };
		_anchorCache.set(file, empty);
		return empty;
	}

	let header: any = null;
	const anchors: CachedAnchorEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }

		if (entry.type === "session") {
			header = entry;
			continue;
		}

		if (
			entry.type === "message" &&
			entry.message?.role === "toolResult" &&
			entry.message?.toolName === "context" &&
			entry.message?.details?.anchor
		) {
			const a = entry.message.details.anchor;
			if (!a?.name || !a?.summary) continue;
			anchors.push({
				anchorId: entry.id,
				anchorName: a.name,
				summary: a.summary,
				timestamp: entry.timestamp ?? "",
			});
		}
	}

	const result: CachedSessionAnchors = {
		mtime,
		sessionId: header?.id,
		cwd: header?.cwd,
		anchors,
	};
	_anchorCache.set(file, result);
	return result;
}

/**
 * Extract searchable text from any entry type.
 */
export function getEntryText(entry: any): string {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			if (!msg) return "";
			const content = msg.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
			}
			return "";
		}
		case "compaction":
		case "branch_summary":
			return entry.summary ?? "";
		case "custom_message":
			return typeof entry.content === "string" ? entry.content : "";
		default:
			return "";
	}
}

export function formatEntryPreview(entry: any): string {
	const id = entry.id as string;
	const ts = (entry.timestamp as string)?.slice(0, 19) ?? "";
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			if (!msg) return `[${id}] ${ts} message: (empty)`;
			const role = msg.role as string;
			let preview = "";
			if (role === "user" || role === "assistant") {
				const content = msg.content;
				if (typeof content === "string") preview = content.slice(0, 120);
				else if (Array.isArray(content)) {
					for (const c of content) {
						if (c.type === "text") { preview = c.text.slice(0, 120); break; }
						if (c.type === "toolCall") { preview = `[tool: ${c.name ?? "?"}]`; break; }
					}
				}
			} else if (role === "toolResult") {
				preview = `[${msg.toolName}] ${msg.isError ? "ERROR" : "OK"}`;
			} else if (role === "custom") {
				preview = `[${msg.customType}]`;
			} else {
				preview = role;
			}
			return `[${id}] ${ts} ${role}: ${preview.replace(/\n/g, " ")}`;
		}
		case "model_change":
			return `[${id}] ${ts} model_change: ${entry.provider}/${entry.modelId}`;
		case "thinking_level_change":
			return `[${id}] ${ts} thinking: ${entry.thinkingLevel}`;
		case "compaction": {
			const s = (entry.summary as string) ?? "";
			return `[${id}] ${ts} compaction: ${s.slice(0, 80)}${s.length > 80 ? "..." : ""}`;
		}
		case "branch_summary": {
			const s = (entry.summary as string) ?? "";
			return `[${id}] ${ts} branch_summary: ${s.slice(0, 80)}${s.length > 80 ? "..." : ""}`;
		}
		case "label":
			return `[${id}] ${ts} label: "${entry.label}" → ${entry.targetId}`;
		case "session_info":
			return `[${id}] ${ts} session_info: name="${entry.name}"`;
		case "custom":
			return `[${id}] ${ts} custom: ${entry.customType}`;
		case "custom_message": {
			const content = typeof entry.content === "string" ? entry.content : "";
			return `[${id}] ${ts} custom_message: [${entry.customType}] ${content.slice(0, 80).replace(/\n/g, " ")}`;
		}
		default:
			return `[${id}] ${ts} ${entry.type}`;
	}
}
