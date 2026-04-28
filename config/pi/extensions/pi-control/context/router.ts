import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { resolveTarget, getAnchors, findAnchorByName, formatAnchorContent, type AnchorState } from "./anchors.js";
import { scheduleAction } from "../command-actions.js";
import { scanAnchors } from "../utils.js";

export function registerContextRouter(pi: ExtensionAPI) {
	pi.registerTool({
		name: "context",
		label: "Context",
		description: [
			"Context management.",
			"view: show anchor tree across all branches in the current session.",
			"recall: scan anchors across past sessions by keyword, without switching.",
			"anchor: create a checkpoint visible in context (name + summary).",
			"pivot: jump to a prior anchor with carryover summary.",
		].join(" "),
		promptSnippet: "Context management: view, recall, anchor, pivot",
		promptGuidelines: [
			"Use context(action='anchor') at task boundaries and before risky changes.",
			"Use context(action='view') to see all anchors in this session before deciding where to pivot.",
			"Use context(action='recall') before starting work to check if related anchors exist in past sessions.",
			"Use context(action='pivot') to return to a prior anchor with a carryover summary when changing approach.",
		],
		parameters: Type.Object({
			action: StringEnum(["view", "recall", "anchor", "pivot"] as const, {
				description: "Action to perform",
			}),
			limit: Type.Optional(Type.Number({ description: "Max results to show. Default: 30 for view, 10 for recall." })),
			keyword: Type.Optional(Type.String({ description: "Keyword (case-insensitive) matched against anchor name and summary. For recall." })),
			scope: Type.Optional(StringEnum(["cwd", "all"] as const, { description: '"cwd" (default) limits recall to sessions in the current working directory; "all" scans every session. For recall.' })),
			name: Type.Optional(Type.String({ description: "Anchor name (must be unique). For anchor." })),
			summary: Type.Optional(Type.String({ description: "Retrospective state: what's done, key decisions, what was confirmed. For anchor." })),
			target: Type.Optional(Type.String({ description: 'Target: anchor name, entry ID, "root", or "head". For pivot.' })),
			carryover: Type.Optional(Type.String({ description: "Required summary of current progress to carry into the new branch. For pivot." })),
			message: Type.Optional(Type.String({ description: "Optional followUp message after pivot completes. Defaults to 'Pivot complete. Continue from the target anchor.' For pivot." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				// ── view ─────────────────────────────────────────────
				case "view": {
					const limit = Math.max(0, Math.trunc(params.limit ?? 30));
					const anchors = getAnchors(ctx.sessionManager);

					if (anchors.length === 0) {
						return {
							content: [{ type: "text", text: "No anchors in this session." }],
							details: { anchors: 0 },
						};
					}

					const currentBranchIds = new Set(ctx.sessionManager.getBranch().map((e: any) => e.id));

					// Partition with on-branch priority so the navigation spine survives `limit`.
					const allOnBranch = anchors.filter(a => currentBranchIds.has(a.data.targetId));
					const allOffBranch = anchors.filter(a => !currentBranchIds.has(a.data.targetId));

					const onBranch = limit > 0 ? allOnBranch.slice(-limit) : [];
					const remaining = Math.max(0, limit - onBranch.length);
					const offBranch = remaining > 0 ? allOffBranch.slice(-remaining) : [];
					const shown = [...onBranch, ...offBranch];

					// Render: on-branch newest-first, then a flat off-branch section.
					const lines: string[] = [];
					const reversedOn = [...onBranch].reverse();
					for (let i = 0; i < reversedOn.length; i++) {
						const a = reversedOn[i];
						if (i > 0) lines.push("");
						const marker = i === 0 ? " <- latest" : "";
						lines.push(`${a.data.name} [${a.data.targetId.slice(0, 8)}]${marker}`);
						lines.push(`  summary: ${a.data.summary}`);
					}

					if (offBranch.length > 0) {
						if (lines.length > 0) lines.push("");
						lines.push("off-branch:");
						const reversedOff = [...offBranch].reverse();
						for (let i = 0; i < reversedOff.length; i++) {
							const a = reversedOff[i];
							if (i > 0) lines.push("");
							lines.push(`  ${a.data.name} [${a.data.targetId.slice(0, 8)}]`);
							lines.push(`    summary: ${a.data.summary}`);
						}
					}

					const header = `anchors (${shown.length}/${anchors.length})`;
					const body = lines.length > 0 ? `${header}\n${lines.join("\n")}` : header;
					return {
						content: [{ type: "text", text: body }],
						details: { total: anchors.length, shown: shown.length },
					};
				}

				// ── recall ──────────────────────────────
				case "recall": {
					if (!params.keyword) {
						return { content: [{ type: "text", text: "`keyword` is required for recall." }], details: {} };
					}
					const limit = Math.max(0, Math.trunc(params.limit ?? 10));
					const scope = (params.scope ?? "cwd") as "cwd" | "all";
					const matches = await scanAnchors(params.keyword, scope, ctx.cwd, limit, signal);

					if (matches.length === 0) {
						return {
							content: [{ type: "text", text: `No anchors matching "${params.keyword}" (scope: ${scope}).` }],
							details: { matches: 0, scope },
						};
					}

					const uniqueSessions = new Set(matches.map(m => m.sessionFile));
					const headerLine = `recall "${params.keyword}" (${matches.length} match${matches.length === 1 ? "" : "es"} across ${uniqueSessions.size} session${uniqueSessions.size === 1 ? "" : "s"}, scope: ${scope})`;

					const lines = matches.map(m => {
						const firstLine = (m.summary.split("\n")[0] ?? "").slice(0, 100);
						const ellipsis = (m.summary.split("\n")[0] ?? "").length > 100 ? "..." : "";
						const dateStr = m.timestamp ? m.timestamp.slice(0, 10) : "";
						const basename = m.sessionFile.split("/").pop() ?? m.sessionFile;
						return `- ${m.anchorName} [${m.anchorId.slice(0, 8)}]  @ ${basename}\n  (${dateStr}) ${firstLine}${ellipsis}`;
					});

					return {
						content: [{ type: "text", text: [headerLine, "", ...lines, "", "Use sessions(action='resume', sessionFile=...) to switch into a matching session."].join("\n") }],
						details: { matches: matches.length, scope, anchors: matches },
					};
				}

				// ── anchor ──────────────────────────────────────────
				case "anchor": {
					if (!params.name || !params.summary) {
						return { content: [{ type: "text", text: "`name` and `summary` are required for anchor." }], details: {} };
					}

					// Check name uniqueness
					const existing = findAnchorByName(ctx.sessionManager, params.name);
					if (existing) {
						const firstLine = existing.summary.split("\n")[0] ?? "";
						const preview = firstLine.slice(0, 100);
						const ellipsis = firstLine.length > 100 ? "..." : "";
						return {
							content: [{
								type: "text",
								text: `Anchor "${params.name}" already exists at [${existing.targetId.slice(0, 8)}]:\n  summary: ${preview}${ellipsis}\nChoose a different name (e.g. ${params.name}-v2, ${params.name}-revised) or review the existing one via context(view).`,
							}],
							details: {},
						};
					}

					// Also check against generic labels
					const entries = ctx.sessionManager.getEntries();
					for (const e of entries) {
						if (ctx.sessionManager.getLabel(e.id) === params.name) {
							return {
								content: [{
									type: "text",
									text: `Label "${params.name}" is already used by entry [${e.id.slice(0, 8)}]. Choose a different name.`,
								}],
								details: {},
							};
						}
					}

					const leafId = ctx.sessionManager.getLeafId();
					if (!leafId) {
						return { content: [{ type: "text", text: "No current leaf to anchor." }], details: {} };
					}

					const anchorData: AnchorState = {
						name: params.name,
						targetId: leafId,
						summary: params.summary,
					};

					// Return anchor content in tool result:
					// - content: visible to LLM on this turn
					// - details.anchor: structured data for getAnchors() to discover via getEntries()
					const content = formatAnchorContent(params.name, params.summary);
					return {
						content: [{ type: "text", text: content }],
						details: { anchor: anchorData },
					};
				}

				// ── pivot ───────────────────────────────────────────
				case "pivot": {
					if (!params.target) {
						return { content: [{ type: "text", text: "`target` is required for pivot." }], details: {} };
					}
					if (!params.carryover) {
						return { content: [{ type: "text", text: "`carryover` is required for pivot." }], details: {} };
					}
					const targetId = resolveTarget(ctx.sessionManager, params.target);
					if (!targetId) {
						return { content: [{ type: "text", text: `Target "${params.target}" not found. Use context(action='view') to find valid anchors.` }], details: {} };
					}
					if (targetId === ctx.sessionManager.getLeafId()) {
						return { content: [{ type: "text", text: "Pivot target is already the current leaf. Choose an earlier anchor or entry." }], details: {} };
					}
					return scheduleAction({
						fallbackHint: "Use built-in `/tree` to navigate instead.",
						action: {
							kind: "pivot",
							targetId,
							carryover: params.carryover!,
							message: params.message,
						},
						successText: `Scheduled pivot to ${params.target} (${targetId.slice(0, 8)})${params.message ? " (with custom followUp message)" : ""}.`,
						details: { scheduled: "pivot", targetId, message: params.message },
					});
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	});
}
