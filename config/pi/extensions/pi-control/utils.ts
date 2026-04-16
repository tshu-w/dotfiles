import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export function getSessionsDir(): string {
	return path.join(getAgentDir(), "sessions");
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
	cwd?: string;
}

export async function scanSessions(
	keyword?: string,
	limit = 10,
	signal?: AbortSignal,
	mode: "metadata" | "fulltext" = "metadata",
): Promise<SessionScanResult[]> {
	const sessionsDir = getSessionsDir();
	if (!fs.existsSync(sessionsDir)) return [];

	const results: SessionScanResult[] = [];
	const allFiles: { file: string; mtime: number }[] = [];

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
				allFiles.push({ file: fullPath, mtime: fstat.mtimeMs });
			} catch { /* skip */ }
		}
	}

	allFiles.sort((a, b) => b.mtime - a.mtime);
	const lowerKeyword = keyword?.toLowerCase();

	for (const { file } of allFiles) {
		if (signal?.aborted || results.length >= limit) break;

		let header: any = null;
		let sessionName: string | undefined;
		let firstUserMsg: string | undefined;
		let fulltextMatch = false;

		try {
			if (mode === "fulltext" && lowerKeyword) {
				// Fast whole-file string search
				const raw = fs.readFileSync(file, "utf-8");
				if (!raw.toLowerCase().includes(lowerKeyword)) continue;
				fulltextMatch = true;
			}

			// Parse header + metadata from first 50 lines
			const fileStream = fs.createReadStream(file, { encoding: "utf-8" });
			const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
			let lineCount = 0;

			for await (const line of rl) {
				if (signal?.aborted) break;
				if (!line.trim()) continue;
				lineCount++;
				if (lineCount > 50) break;
				try {
					const entry = JSON.parse(line);
					if (entry.type === "session") header = entry;
					if (entry.type === "session_info" && entry.name) sessionName = entry.name;
					if (!firstUserMsg && entry.type === "message" && entry.message?.role === "user") {
						const content = entry.message.content;
						if (typeof content === "string") {
							firstUserMsg = content.slice(0, 300);
						} else if (Array.isArray(content)) {
							for (const c of content) {
								if (c.type === "text") { firstUserMsg = c.text.slice(0, 300); break; }
							}
						}
					}
					if (header && firstUserMsg) break;
				} catch { /* skip malformed */ }
			}
			rl.close();
			fileStream.destroy();
		} catch { continue; }

		if (mode === "fulltext") {
			// Already confirmed match via raw string search above
			if (fulltextMatch) {
				results.push({
					file,
					sessionId: header?.id ?? path.basename(file, ".jsonl"),
					timestamp: header?.timestamp ?? "",
					name: sessionName,
					firstMessage: firstUserMsg,
					cwd: header?.cwd,
				});
			}
		} else {
			const searchTarget = [sessionName ?? "", firstUserMsg ?? "", file, header?.cwd ?? ""].join(" ").toLowerCase();
			if (!lowerKeyword || searchTarget.includes(lowerKeyword)) {
				results.push({
					file,
					sessionId: header?.id ?? path.basename(file, ".jsonl"),
					timestamp: header?.timestamp ?? "",
					name: sessionName,
					firstMessage: firstUserMsg,
					cwd: header?.cwd,
				});
			}
		}
	}

	return results;
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
						if (c.type === "toolCall") { preview = `[tool: ${c.name}]`; break; }
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
		case "compaction":
			return `[${id}] ${ts} compaction: ${(entry.summary as string)?.slice(0, 80)}...`;
		case "branch_summary":
			return `[${id}] ${ts} branch_summary: ${(entry.summary as string)?.slice(0, 80)}...`;
		case "label":
			return `[${id}] ${ts} label: "${entry.label}" → ${entry.targetId}`;
		case "session_info":
			return `[${id}] ${ts} session_info: name="${entry.name}"`;
		case "custom":
			return `[${id}] ${ts} custom: ${entry.customType}`;
		default:
			return `[${id}] ${ts} ${entry.type}`;
	}
}
