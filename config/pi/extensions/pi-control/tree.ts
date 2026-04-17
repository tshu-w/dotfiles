import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatEntryPreview } from "./utils.js";
import { isArmed, setPendingNav, setPendingFork } from "./command-actions.js";

export function registerTreeRouter(pi: ExtensionAPI) {
	pi.registerTool({
		name: "tree",
		label: "Tree",
		description: [
			"Session entry operations.",
			"list: browse entries (IDs, types, previews).",
			"search: find entries by keyword.",
			"labels: show labeled/bookmarked entries.",
			"navigate: jump to a different point in the session tree.",
			"fork: create a new session forked from a specific entry.",
			"compact: summarize older messages to free up context window.",
		].join(" "),
		promptSnippet: "Session tree: list, search, labels, navigate, fork, compact",
		promptGuidelines: [
			"Use tree(action='list') or tree(action='search') to find entry IDs before navigate or fork.",
			"Use tree(action='compact') proactively when context usage is high.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "search", "labels", "navigate", "fork", "compact"] as const, {
				description: "Action to perform",
			}),
			// list params
			scope: Type.Optional(StringEnum(["branch", "all"] as const, { description: '"branch" (default) or "all". For list.' })),
			limit: Type.Optional(Type.Number({ description: "Max entries. Default: 20 (list), 10 (search). For list/search." })),
			offset: Type.Optional(Type.Number({ description: "Skip N entries from the end. Default: 0. For list." })),
			types: Type.Optional(Type.Array(Type.String(), { description: 'Filter by entry type, e.g. ["message", "compaction"]. For list.' })),
			// search params
			keyword: Type.Optional(Type.String({ description: "Search keyword (case-insensitive). For search." })),
			// navigate params
			entryId: Type.Optional(Type.String({ description: "Target entry ID (8-char hex). For navigate/fork." })),
			summarize: Type.Optional(Type.Boolean({ description: "Summarize abandoned branch. Default: false. For navigate." })),
			customInstructions: Type.Optional(Type.String({ description: "Custom instructions for context summarization. For navigate/compact." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				// ── list ─────────────────────────────────────────────
				case "list": {
					const scope = params.scope ?? "branch";
					const limit = params.limit ?? 20;
					const offset = params.offset ?? 0;

					let entries = scope === "branch"
						? ctx.sessionManager.getBranch()
						: ctx.sessionManager.getEntries();

					if (params.types && params.types.length > 0) {
						const typeSet = new Set(params.types);
						entries = entries.filter((e: any) => typeSet.has(e.type));
					}

					const reversed = [...entries].reverse();
					const page = reversed.slice(offset, offset + limit);

					if (page.length === 0) {
						return {
							content: [{ type: "text", text: `No entries found (total: ${entries.length}, offset: ${offset}).` }],
							details: { total: entries.length, shown: 0 },
						};
					}

					const lines = page.map((e: any) => formatEntryPreview(e));
					const header = `**${scope === "branch" ? "Branch" : "All"} entries** (showing ${page.length} of ${entries.length}, offset ${offset}):`;

					return {
						content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
						details: { total: entries.length, shown: page.length, offset },
					};
				}

				// ── search ──────────────────────────────────────────
				case "search": {
					if (!params.keyword) {
						return { content: [{ type: "text", text: "`keyword` is required for search." }], details: {} };
					}
					const kw = params.keyword.toLowerCase();
					const limit = params.limit ?? 10;
					const branch = ctx.sessionManager.getBranch();
					const matches: string[] = [];

					for (const entry of [...branch].reverse()) {
						if (matches.length >= limit) break;
						const e = entry as any;
						if (e.type !== "message") continue;

						const msg = e.message;
						let text = "";
						if (typeof msg.content === "string") {
							text = msg.content;
						} else if (Array.isArray(msg.content)) {
							text = msg.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join(" ");
						}

						if (text.toLowerCase().includes(kw)) {
							matches.push(formatEntryPreview(e));
						}
					}

					if (matches.length === 0) {
						return {
							content: [{ type: "text", text: `No entries matching "${params.keyword}" on current branch.` }],
							details: { matches: 0 },
						};
					}

					return {
						content: [{ type: "text", text: `**Matches for "${params.keyword}"** (${matches.length}):\n${matches.join("\n")}` }],
						details: { matches: matches.length },
					};
				}

				// ── labels ──────────────────────────────────────────
				case "labels": {
					const entries = ctx.sessionManager.getEntries();
					const labeled: Array<{ id: string; label: string; preview: string }> = [];

					for (const entry of entries) {
						const e = entry as any;
						const label = ctx.sessionManager.getLabel(e.id);
						if (label) {
							labeled.push({ id: e.id, label, preview: formatEntryPreview(e) });
						}
					}

					if (labeled.length === 0) {
						return {
							content: [{ type: "text", text: "No labeled entries in this session." }],
							details: { labels: [] },
						};
					}

					const lines = labeled.map(l => `- **"${l.label}"** → ${l.preview}`);
					return {
						content: [{ type: "text", text: `**Labels** (${labeled.length}):\n${lines.join("\n")}` }],
						details: { labels: labeled },
					};
				}

				// ── navigate ────────────────────────────────────────
				case "navigate": {
					if (!params.entryId) {
						return { content: [{ type: "text", text: "`entryId` is required for navigate." }], details: {} };
					}
					if (!isArmed()) {
						return { content: [{ type: "text", text: "Command context not captured. Use built-in `/tree` instead." }], details: {} };
					}
					setPendingNav({
						targetId: params.entryId,
						summarize: params.summarize ?? false,
						customInstructions: params.customInstructions,
					});
					return {
						content: [{ type: "text", text: `Scheduled tree navigation to entry: ${params.entryId}` }],
						details: { scheduled: "navigate", entryId: params.entryId },
					};
				}

				// ── fork ────────────────────────────────────────────
				case "fork": {
					if (!params.entryId) {
						return { content: [{ type: "text", text: "`entryId` is required for fork." }], details: {} };
					}
					if (!isArmed()) {
						return { content: [{ type: "text", text: "Command context not captured. Use built-in `/fork` instead." }], details: {} };
					}
					setPendingFork(params.entryId);
					return {
						content: [{ type: "text", text: `Scheduled fork from entry: ${params.entryId}` }],
						details: { scheduled: "fork", entryId: params.entryId },
					};
				}

				// ── compact ─────────────────────────────────────────
				case "compact": {
					ctx.compact({
						customInstructions: params.customInstructions,
						onComplete: () => {},
						onError: () => {},
					});
					return {
						content: [{ type: "text", text: "Compaction triggered." + (params.customInstructions ? ` Instructions: "${params.customInstructions}"` : "") }],
						details: {},
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	});
}
