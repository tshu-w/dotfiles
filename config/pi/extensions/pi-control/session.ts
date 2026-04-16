import * as fs from "node:fs";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getSessionsDir, scanSessions } from "./utils.js";
import { isArmed, setPendingResume, setPendingNew } from "./command-actions.js";

export function registerSessionsRouter(pi: ExtensionAPI) {
	pi.registerTool({
		name: "sessions",
		label: "Sessions",
		description: [
			"Session management router.",
			"info: current session state (model, tokens, cwd).",
			"search: find past sessions by keyword (metadata or fulltext).",
			"resume: switch to a different session by file path.",
			"new: start a new session.",
			"name: set session display name.",
		].join(" "),
		promptSnippet: "Session management: info, search, resume, new, name",
		promptGuidelines: [
			"Use sessions(action='info') to check current model, tokens, and cwd.",
			"Use sessions(action='search') to find past sessions, then sessions(action='resume') to switch.",
			"Confirm with the user before resume or new, as current context will be lost.",
		],
		parameters: Type.Object({
			action: StringEnum(["info", "search", "resume", "new", "name"] as const, {
				description: "Action to perform",
			}),
			// search params
			keyword: Type.Optional(Type.String({ description: "Search keyword (case-insensitive). For search." })),
			mode: Type.Optional(StringEnum(["metadata", "fulltext"] as const, {
				description: '"metadata" (default, fast) or "fulltext" (searches entire session content). For search.',
			})),
			limit: Type.Optional(Type.Number({ description: "Max results. Default: 10. For search." })),
			// resume params
			sessionFile: Type.Optional(Type.String({ description: "Full path to session .jsonl file. For resume." })),
			// new params
			linkParent: Type.Optional(Type.Boolean({ description: "Link current session as parent. Default: true. For new." })),
			// name params
			name: Type.Optional(Type.String({ description: "Display name for the session. For name." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				// ── info ─────────────────────────────────────────────
				case "info": {
					const model = ctx.model;
					const usage = ctx.getContextUsage();
					const sessionFile = ctx.sessionManager.getSessionFile();
					const sessionName = ctx.sessionManager.getSessionName();
					const entries = ctx.sessionManager.getEntries();

					const lines: string[] = [];
					lines.push(`**Model:** ${model ? `${model.provider}/${model.id}` : "none"}`);
					lines.push(`**Thinking:** ${pi.getThinkingLevel()}`);
					lines.push(`**Session:** ${sessionName || "(unnamed)"}`);
					lines.push(`**File:** ${sessionFile || "(ephemeral)"}`);
					lines.push(`**CWD:** ${ctx.cwd}`);
					lines.push(`**Entries:** ${entries.length}`);
					if (usage) lines.push(`**Context tokens:** ${usage.tokens}/${usage.contextWindow}`);

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { model: model ? `${model.provider}/${model.id}` : null, usage },
					};
				}

				// ── search ──────────────────────────────────────────
				case "search": {
					const results = await scanSessions(params.keyword, params.limit ?? 10, signal, params.mode ?? "metadata");

					if (results.length === 0) {
						return {
							content: [{ type: "text", text: `No sessions found${params.keyword ? ` matching "${params.keyword}"` : ""}. Sessions dir: ${getSessionsDir()}` }],
							details: { results: [] },
						};
					}

					const lines = results.map((r, i) => {
						const parts = [`${i + 1}. **${r.name || "(unnamed)"}**`];
						parts.push(`   File: \`${r.file}\``);
						if (r.timestamp) parts.push(`   Time: ${r.timestamp}`);
						if (r.cwd) parts.push(`   CWD: ${r.cwd}`);
						if (r.firstMessage) parts.push(`   Preview: ${r.firstMessage.slice(0, 150)}`);
						return parts.join("\n");
					});

					return {
						content: [{ type: "text", text: lines.join("\n\n") + "\n\nUse sessions(action='resume', sessionFile=...) to switch." }],
						details: { results },
					};
				}

				// ── resume ──────────────────────────────────────────
				case "resume": {
					if (!params.sessionFile) {
						return { content: [{ type: "text", text: "`sessionFile` is required for resume." }], details: {} };
					}
					if (!fs.existsSync(params.sessionFile)) {
						return { content: [{ type: "text", text: `Session file not found: ${params.sessionFile}` }], details: {} };
					}
					if (!isArmed()) {
						return { content: [{ type: "text", text: "Command context not captured. Use built-in `/resume` instead." }], details: {} };
					}
					setPendingResume(params.sessionFile);
					return {
						content: [{ type: "text", text: `Scheduled session switch to: ${params.sessionFile}` }],
						details: { scheduled: "resume", sessionFile: params.sessionFile },
					};
				}

				// ── new ─────────────────────────────────────────────
				case "new": {
					if (!isArmed()) {
						return { content: [{ type: "text", text: "Command context not captured. Use built-in `/new` instead." }], details: {} };
					}
					const currentFile = ctx.sessionManager.getSessionFile();
					setPendingNew({
						parentSession: (params.linkParent ?? true) ? currentFile ?? undefined : undefined,
					});
					return {
						content: [{ type: "text", text: "Scheduled new session creation." }],
						details: { scheduled: "new" },
					};
				}

				// ── name ────────────────────────────────────────────
				case "name": {
					if (!params.name) {
						return { content: [{ type: "text", text: "`name` is required for name." }], details: {} };
					}
					pi.setSessionName(params.name);
					return {
						content: [{ type: "text", text: `Session named: "${params.name}"` }],
						details: {},
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	});
}
