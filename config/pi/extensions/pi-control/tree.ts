import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatEntryPreview, getEntryText } from "./utils.js";
import { scheduleAction } from "./command-actions.js";
import { buildGroupedOverview, renderGroupedOverview } from "./grouped.js";

const SETTINGS_TYPES = new Set(["label", "custom", "custom_message", "model_change", "thinking_level_change", "session_info"]);

export function registerTreeRouter(pi: ExtensionAPI) {
	pi.registerTool({
		name: "tree",
		label: "Tree",
		description: [
			"Session entry operations.",
			"list: browse current-branch entries or a session-wide branch overview.",
			"search: find entries by keyword.",
			"labels: show labeled/bookmarked entries.",
			"set_label: set or clear a label on an entry (lightweight bookmark).",
			"navigate: jump to a different point in the session tree.",
			"fork: create a new session forked before a specific user-message entry.",
			"compact: summarize older messages to free up context window.",
		].join(" "),
		promptSnippet: "Session tree: list, search, labels, set_label, navigate, fork, compact",
		promptGuidelines: [
			"Use tree(action='list') or tree(action='search') to find entry IDs before navigate or fork.",
			"For fork, choose a user-message entry ID.",
			"Use tree(action='set_label', entryId, label) to bookmark an entry; omit label to clear.",
			"Use tree(action='compact') proactively when context usage is high.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "search", "labels", "set_label", "navigate", "fork", "compact"] as const, {
				description: "Action to perform",
			}),
			// list params
			scope: Type.Optional(StringEnum(["branch", "all"] as const, { description: '"branch" (default) or "all". For list.' })),
			limit: Type.Optional(Type.Number({ description: 'Max items. For list: scope="branch" = entries, scope="all" = fork points. Default: 20. For search: default 10.' })),
			offset: Type.Optional(Type.Number({ description: 'Skip N items for list pagination. For scope="branch": entries from the end. For scope="all": fork points after the current branch summary. Default: 0.' })),
			filter: Type.Optional(StringEnum(["default", "user-only", "no-tools", "labeled-only", "all"] as const, {
				description: 'Filter mode for `scope="branch"`. "default" hides settings entries, "user-only" shows only user messages, "no-tools" hides tool results, "labeled-only" shows labeled entries, "all" shows everything. Default: "default". For list.',
			})),
			types: Type.Optional(Type.Array(Type.String(), { description: 'Filter by entry type for `scope="branch"`, e.g. ["message", "compaction"]. Overrides filter if set. For list.' })),
			// search params
			keyword: Type.Optional(Type.String({ description: "Search keyword (case-insensitive). For search." })),
			// navigate / fork / set_label params
			entryId: Type.Optional(Type.String({ description: "Target entry ID (8-char hex). For navigate/fork/set_label." })),
			label: Type.Optional(Type.String({ description: "Label to set. Omit to clear. For set_label." })),
			summarize: Type.Optional(Type.Boolean({ description: "Summarize abandoned branch. Default: false. For navigate. (context(pivot) always summarizes regardless.)" })),
			customInstructions: Type.Optional(Type.String({ description: "Custom instructions for context summarization. For navigate/compact." })),
			message: Type.Optional(Type.String({ description: "Optional message to deliver after the action completes. For navigate: followUp in current session. For fork: injected into the new forked session via withSession. For compact: followUp in current session after compaction completes (overrides default 'Compaction complete. Continue.')." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				// ── list ─────────────────────────────────────────────
				case "list": {
					const scope = params.scope ?? "branch";
					const limit = Math.max(0, Math.trunc(params.limit ?? 20));
					const offset = Math.max(0, Math.trunc(params.offset ?? 0));

					if (scope === "all") {
						if (params.filter !== undefined || (params.types && params.types.length > 0)) {
							return {
								content: [{ type: "text", text: "`filter` and `types` are only supported with scope=\"branch\"." }],
								details: {},
							};
						}

						const tree = ctx.sessionManager.getTree();
						const branchEntries = ctx.sessionManager.getBranch();
						if (!tree || tree.length === 0 || branchEntries.length === 0) {
							return {
								content: [{ type: "text", text: "No entries in session." }],
								details: { scope: "all", currentBranch: null, forkPoints: { total: 0, shown: 0, offset, limit, hasMore: false, groups: [] }, totalSideBranches: 0 },
							};
						}

						const getLabel = (id: string) => ctx.sessionManager.getLabel(id);
						const overview = buildGroupedOverview(tree as any[], branchEntries as any[], getLabel, offset, limit);
						if (!overview) {
							return {
								content: [{ type: "text", text: "No entries in session." }],
								details: { scope: "all", currentBranch: null, forkPoints: { total: 0, shown: 0, offset, limit, hasMore: false, groups: [] }, totalSideBranches: 0 },
							};
						}

						return {
							content: [{ type: "text", text: renderGroupedOverview(overview).join("\n") }],
							details: {
								scope: "all",
								currentBranch: overview.currentBranch,
								forkPoints: {
									total: overview.totalForkPoints,
									shown: overview.shownForkPoints,
									offset: overview.offset,
									limit: overview.limit,
									hasMore: overview.hasMore,
									groups: overview.forkPoints,
								},
								totalSideBranches: overview.totalSideBranches,
							},
						};
					}

					// Branch view — linear, supports filter
					let entries = ctx.sessionManager.getBranch() as any[];

					if (params.types && params.types.length > 0) {
						const typeSet = new Set(params.types);
						entries = entries.filter((e: any) => typeSet.has(e.type));
					} else {
						const filterMode = params.filter ?? "default";
						entries = entries.filter((e: any) => {
							switch (filterMode) {
								case "user-only":
									return e.type === "message" && e.message?.role === "user";
								case "no-tools":
									return !SETTINGS_TYPES.has(e.type) && !(e.type === "message" && e.message?.role === "toolResult");
								case "labeled-only":
									return ctx.sessionManager.getLabel(e.id) !== undefined;
								case "all":
									return true;
								default: // "default"
									return !SETTINGS_TYPES.has(e.type);
							}
						});
					}

					const total = entries.length;
					const reversed = [...entries].reverse();
					const page = reversed.slice(offset, offset + limit);

					if (page.length === 0) {
						return {
							content: [{ type: "text", text: `No entries found (total: ${total}, offset: ${offset}).` }],
							details: { total, shown: 0 },
						};
					}

					const lines = page.map((e: any) => {
						const preview = formatEntryPreview(e);
						const label = ctx.sessionManager.getLabel(e.id);
						return label ? `${preview}  @${label}` : preview;
					});
					const headerLabel = scope === "branch" ? "branch entries newest-first" : "all entries";
					const header = `${headerLabel} (${page.length}/${total}, offset ${offset})`;
					const footers: string[] = [];
					if (offset > 0) {
						const prevOffset = Math.max(0, offset - limit);
						footers.push(`newer entries available via offset ${prevOffset}`);
					}
					if (offset + page.length < total) {
						footers.push(`older entries available via offset ${offset + page.length}`);
					}
					const body = [header, ...lines, ...footers].join("\n");

					return {
						content: [{ type: "text", text: body }],
						details: { total, shown: page.length, offset },
					};
				}

				// ── search ──────────────────────────────────────────
				case "search": {
					if (!params.keyword) {
						return { content: [{ type: "text", text: "`keyword` is required for search." }], details: {} };
					}
					const kw = params.keyword.toLowerCase();
					const limit = Math.max(0, Math.trunc(params.limit ?? 10));

					// Search entire tree, not just current branch
					const tree = ctx.sessionManager.getTree();
					const branchIds = new Set(ctx.sessionManager.getBranch().map((e: any) => e.id));
					const allEntries: any[] = [];
					const walkStack: any[] = [...(tree ?? [])];
					while (walkStack.length > 0) {
						const node = walkStack.pop()!;
						allEntries.push(node.entry);
						if (node.children) {
							for (const child of node.children) walkStack.push(child);
						}
					}

					// Sort by timestamp descending (newest first)
					allEntries.sort((a, b) => {
						const ta = Date.parse(a.timestamp || "") || 0;
						const tb = Date.parse(b.timestamp || "") || 0;
						return tb - ta;
					});

					const matches: Array<{ preview: string; onBranch: boolean }> = [];
					for (const entry of allEntries) {
						if (matches.length >= limit) break;
						const text = getEntryText(entry);
						if (text && text.toLowerCase().includes(kw)) {
							matches.push({
								preview: formatEntryPreview(entry),
								onBranch: branchIds.has(entry.id),
							});
						}
					}

					if (matches.length === 0) {
						return {
							content: [{ type: "text", text: `No entries matching "${params.keyword}" in session.` }],
							details: { matches: 0 },
						};
					}

					const lines = matches.map(m => m.onBranch ? m.preview : `${m.preview}  [off-branch]`);
					return {
						content: [{ type: "text", text: `matches for "${params.keyword}" (${matches.length})\n${lines.join("\n")}` }],
						details: { matches: matches.length },
					};
				}

				// ── labels ──────────────────────────────────────────
				case "labels": {
					const entries = ctx.sessionManager.getEntries();
					const branchIds = new Set(ctx.sessionManager.getBranch().map((e: any) => e.id));
					const labeled: Array<{ id: string; label: string; preview: string; onBranch: boolean }> = [];

					for (const entry of entries) {
						const e = entry as any;
						const label = ctx.sessionManager.getLabel(e.id);
						if (label) {
							labeled.push({ id: e.id, label, preview: formatEntryPreview(e), onBranch: branchIds.has(e.id) });
						}
					}

					if (labeled.length === 0) {
						return {
							content: [{ type: "text", text: "No labeled entries in this session." }],
							details: { labels: [] },
						};
					}

					const lines = labeled.map(l =>
						`- "${l.label}" → ${l.preview}${l.onBranch ? "" : "  [off-branch]"}`
					);
					return {
						content: [{ type: "text", text: `labels (${labeled.length})\n${lines.join("\n")}` }],
						details: { labels: labeled },
					};
				}

				// ── set_label ───────────────────────────
				case "set_label": {
					if (!params.entryId) {
						return { content: [{ type: "text", text: "`entryId` is required for set_label." }], details: {} };
					}
					const target = ctx.sessionManager.getEntry(params.entryId);
					if (!target) {
						return { content: [{ type: "text", text: `Entry not found: ${params.entryId}` }], details: {} };
					}

					// Clear label if none provided
					if (!params.label) {
						pi.setLabel(params.entryId, undefined);
						return {
							content: [{ type: "text", text: `Label cleared on [${params.entryId.slice(0, 8)}].` }],
							details: { entryId: params.entryId, cleared: true },
						};
					}

					// Reject collisions with existing labels on other entries
					const allEntries = ctx.sessionManager.getEntries();
					for (const e of allEntries) {
						const eid = (e as any).id;
						if (eid === params.entryId) continue;
						if (ctx.sessionManager.getLabel(eid) === params.label) {
							return {
								content: [{ type: "text", text: `Label "${params.label}" already used by [${eid.slice(0, 8)}]. Choose a different label.` }],
								details: {},
							};
						}
					}

					pi.setLabel(params.entryId, params.label);
					return {
						content: [{ type: "text", text: `Label "${params.label}" set on [${params.entryId.slice(0, 8)}].` }],
						details: { entryId: params.entryId, label: params.label },
					};
				}

				// ── navigate ────────────────────────────────────────
				case "navigate": {
					if (!params.entryId) {
						return { content: [{ type: "text", text: "`entryId` is required for navigate." }], details: {} };
					}
					const target = ctx.sessionManager.getEntry(params.entryId);
					if (!target) {
						return { content: [{ type: "text", text: `Entry not found: ${params.entryId}` }], details: {} };
					}
					if (params.entryId === ctx.sessionManager.getLeafId()) {
						return { content: [{ type: "text", text: `Already at entry: ${params.entryId}` }], details: { entryId: params.entryId } };
					}
					return scheduleAction({
						fallbackHint: "Use built-in `/tree` instead.",
						action: {
							kind: "nav",
							targetId: target.id,
							summarize: params.summarize ?? false,
							customInstructions: params.customInstructions,
							message: params.message,
						},
						successText: `Scheduled tree navigation to entry: ${target.id}${params.message ? " (with followUp message)" : ""}`,
						details: { scheduled: "navigate", entryId: target.id, message: params.message },
					});
				}

				// ── fork ────────────────────────────────────────────
				case "fork": {
					if (!params.entryId) {
						return { content: [{ type: "text", text: "`entryId` is required for fork." }], details: {} };
					}
					const target = ctx.sessionManager.getEntry(params.entryId);
					if (!target) {
						return { content: [{ type: "text", text: `Entry not found: ${params.entryId}` }], details: {} };
					}
					if (target.type !== "message" || target.message?.role !== "user") {
						const actualKind = target.type === "message"
							? `message role "${target.message?.role ?? "unknown"}"`
							: `type "${target.type}"`;
						return {
							content: [{ type: "text", text: `Fork requires a user-message entry. Entry ${params.entryId} is ${actualKind}.` }],
							details: {},
						};
					}
					return scheduleAction({
						fallbackHint: "Use built-in `/fork` instead.",
						action: { kind: "fork", id: target.id, message: params.message },
						successText: `Scheduled fork from entry: ${target.id}${params.message ? " (with followUp message)" : ""}`,
						details: { scheduled: "fork", entryId: target.id, message: params.message },
					});
				}

				// ── compact ─────────────────────────────────────────
				case "compact": {
					const followUpMsg = params.message ?? "Compaction complete. Continue.";
					ctx.compact({
						customInstructions: params.customInstructions,
						onComplete: () => {
							pi.sendUserMessage(followUpMsg, { deliverAs: "followUp" });
						},
						onError: (err) => {
							pi.sendUserMessage(`Compaction failed: ${err}`, { deliverAs: "followUp" });
						},
					});
					return {
						content: [{ type: "text", text: "Compaction triggered." + (params.customInstructions ? ` Instructions: "${params.customInstructions}"` : "") + (params.message ? " (with custom followUp message)" : "") }],
						details: { scheduled: "compact", message: params.message },
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	});
}
