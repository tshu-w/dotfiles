import * as fs from "node:fs";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getSessionsDir, scanSessions } from "./utils.js";
import { scheduleAction } from "./command-actions.js";

export function registerSessionsRouter(pi: ExtensionAPI) {
	pi.registerTool({
		name: "sessions",
		label: "Sessions",
		description: [
			"Session management.",
			"info: current session details (model, tokens, cwd).",
			"search: find past sessions by keyword.",
			"resume: switch to a different session by file path.",
			"new: start a new session.",
			"name: set session display name.",
			"queue_message: inject a user message into the session.",
			"reload: reload extensions and runtime.",
		].join(" "),
		promptSnippet: "Session management: info, search, resume, new, name, queue_message, reload",
		promptGuidelines: [
			"Use sessions(action='info') to check current model, tokens, and cwd.",
			"Use sessions(action='search') to find past sessions, then sessions(action='resume') to switch.",
			"Confirm with the user before resume or new, as current context will be lost.",
			"Use sessions(action='queue_message') for injecting messages without switching model.",
		],
		parameters: Type.Object({
			action: StringEnum(["info", "search", "resume", "new", "name", "queue_message", "reload"] as const, {
				description: "Action to perform",
			}),
			// search params
			keyword: Type.Optional(Type.String({ description: "Search keyword (case-insensitive). For search." })),
			limit: Type.Optional(Type.Number({ description: "Max results. Default: 10. For search." })),
			scope: Type.Optional(StringEnum(["cwd", "all"] as const, { description: '"cwd" (default) limits search to sessions in the current working directory; "all" scans every session. For search.' })),
			// resume params
			sessionFile: Type.Optional(Type.String({ description: "Full path to session .jsonl file. For resume." })),
			// new params
			linkParent: Type.Optional(Type.Boolean({ description: "Link current session as parent. Default: true. For new." })),
			// name params
			name: Type.Optional(Type.String({ description: "Display name for the session. For name." })),
			// queue_message params (also used as followUp for resume/new/reload)
			message: Type.Optional(Type.String({ description: "Message content. For queue_message: injected immediately in current session. For resume/new: injected into the new session via withSession. For reload: sent as followUp in current session after reload." })),
			deliverAs: Type.Optional(StringEnum(["steer", "followUp"] as const, { description: '"followUp" (default) or "steer". For queue_message.' })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				// ── info ─────────────────────────────────────────────
				case "info": {
					const model = ctx.model;
					const usage = ctx.getContextUsage?.();
					const sessionFile = ctx.sessionManager.getSessionFile();
					const sessionName = ctx.sessionManager.getSessionName();
					const entries = ctx.sessionManager.getEntries();

					const lines: string[] = [];
					lines.push(`model: ${model ? `${model.provider}/${model.id}` : "none"}`);
					lines.push(`thinking: ${pi.getThinkingLevel()}`);
					lines.push(`session: ${sessionName || "(unnamed)"}`);
					lines.push(`file: ${sessionFile || "(ephemeral)"}`);
					lines.push(`cwd: ${ctx.cwd}`);
					lines.push(`entries: ${entries.length}`);
					if (usage && typeof usage.tokens === "number") {
						lines.push(`context tokens: ${usage.tokens}/${usage.contextWindow}`);
					}

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { model: model ? `${model.provider}/${model.id}` : null, usage },
					};
				}

				// ── search ──────────────────────────────────────────
				case "search": {
					const limit = Math.max(0, Math.trunc(params.limit ?? 10));
					const scope = (params.scope ?? "cwd") as "cwd" | "all";
					const results = await scanSessions(params.keyword, limit, signal, { scope, cwd: ctx.cwd });

					if (results.length === 0) {
						return {
							content: [{ type: "text", text: `No sessions found${params.keyword ? ` matching "${params.keyword}"` : ""} (scope: ${scope}). Sessions dir: ${getSessionsDir()}` }],
							details: { results: [], scope },
						};
					}

					const lines = results.map((r, i) => {
						const parts = [`${i + 1}. ${r.name || "(unnamed)"}`];
						parts.push(`   File: \`${r.file}\``);
						if (r.timestamp) parts.push(`   Time: ${r.timestamp}`);
						if (r.cwd) parts.push(`   CWD: ${r.cwd}`);
						if (r.matchSnippets && r.matchSnippets.length > 0) {
							for (const s of r.matchSnippets) parts.push(`   Match: ${s}`);
						} else if (r.firstMessage) {
							parts.push(`   Preview: ${r.firstMessage.slice(0, 150)}`);
						}
						return parts.join("\n");
					});

					return {
						content: [{ type: "text", text: lines.join("\n\n") + "\n\nUse sessions(action='resume', sessionFile=...) to switch." }],
						details: { results, scope },
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
					return scheduleAction({
						fallbackHint: "Use built-in `/resume` instead.",
						action: { kind: "resume", file: params.sessionFile!, message: params.message },
						successText: `Scheduled session switch to: ${params.sessionFile}${params.message ? " (with followUp message)" : ""}`,
						details: { scheduled: "resume", sessionFile: params.sessionFile, message: params.message },
					});
				}

				// ── new ─────────────────────────────────────────────
				case "new": {
					const currentFile = ctx.sessionManager.getSessionFile();
					const parentSession = (params.linkParent ?? true) ? currentFile ?? undefined : undefined;
					return scheduleAction({
						fallbackHint: "Use built-in `/new` instead.",
						action: { kind: "new", parentSession, message: params.message },
						successText: `Scheduled new session creation${params.message ? " (with followUp message)" : ""}.`,
						details: { scheduled: "new", message: params.message },
					});
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

				// ── queue_message ────────────────────────────────────
				case "queue_message": {
					if (!params.message) {
						return { content: [{ type: "text", text: "`message` is required for queue_message." }], details: {} };
					}
					const deliverAs = params.deliverAs ?? "followUp";
					pi.sendUserMessage(params.message, { deliverAs });
					return {
						content: [{ type: "text", text: `Message queued as ${deliverAs}.` }],
						details: { deliverAs },
					};
				}

				// ── reload ───────────────────────────────────────────
				case "reload": {
					return scheduleAction({
						fallbackHint: "Use built-in `/reload` instead.",
						action: { kind: "reload", message: params.message },
						successText: `Scheduled runtime reload${params.message ? " (with followUp message)" : ""}.`,
						details: { scheduled: "reload", message: params.message },
					});
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	});
}
