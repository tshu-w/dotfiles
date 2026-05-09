/**
 * Pi Control — self-control layer for pi.
 *
 * 4 router tools, always active:
 *   context   — context management (view, recall, anchor, pivot)
 *   sessions  — session management (info, search, resume, new, name, queue_message, reload)
 *   tree      — session entry operations (list, search, labels, set_label, navigate, fork, compact)
 *   models    — model listing, switching, and consultation
 *
 * Also registers a context event hook to:
 *   - truncate old tool results (before the last anchor) to save context window
 *   - remind once if no anchors exist after 10+ entries
 *
 * Uses a private API hack to capture command-only closures from
 * ExtensionRunner.prototype.bindCommandContext, then executes
 * pending session/navigation/pivot actions after agent_end + setTimeout(0).
 * Upstream equivalent: pi.runWhenIdle() (#2023).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchBindCommandContext, runPending, clearPending, isArmed, hasPending, getActivePivot } from "./command-actions.js";
import { isAnchorEntry, isAnchorToolResult } from "./context/anchors.js";
import { registerContextRouter } from "./context/router.js";
import { registerSessionsRouter } from "./session.js";
import { registerTreeRouter } from "./tree.js";
import { registerModelsRouter } from "./model.js";

export default function (pi: ExtensionAPI) {
	// Patch ExtensionRunner to auto-capture command context actions.
	const patchOk = patchBindCommandContext();

	registerContextRouter(pi);
	registerSessionsRouter(pi);
	registerTreeRouter(pi);
	registerModelsRouter(pi);

	// ── Context event: truncate old tool results + anchor reminder ──
	// Receives AgentMessage[]. Anchors are toolResults with toolName=="context" and details.anchor.
	let anchorReminderSent = false;
	pi.on("context", async (event, ctx) => {
		const messages = event.messages;
		if (!messages || messages.length === 0) return;

		let modified = false;

		// Find the last anchor index in AgentMessage[] by toolResult details
		let lastAnchorIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (isAnchorToolResult(messages[i])) {
				lastAnchorIdx = i;
				break;
			}
		}

		// Truncate tool results before the last anchor (skip anchor toolResults themselves)
		if (lastAnchorIdx > 0) {
			for (let i = 0; i < lastAnchorIdx; i++) {
				const m = messages[i] as any;
				if (m.role === "toolResult" && !isAnchorToolResult(m)) {
					if (typeof m.content === "string" && m.content.length > 200) {
						m.content = m.content.slice(0, 100) + `\n... [truncated, was ${m.content.length} chars]`;
						modified = true;
					} else if (Array.isArray(m.content)) {
						for (const part of m.content) {
							if (part.type === "text" && part.text && part.text.length > 200) {
								part.text = part.text.slice(0, 100) + `\n... [truncated, was ${part.text.length} chars]`;
								modified = true;
							}
						}
					}
				}
			}
		}

		// Insert status as a standalone message AFTER the last user message.
		// Rationale: putting pi-status at the tail keeps the request prefix identical
		// to the no-status baseline, so prefix cache hits are preserved across turns.
		const currentModel = ctx.model;
		if (currentModel) {
			const usage = ctx.getContextUsage?.();
			const parts: string[] = [`model=${currentModel.provider}/${currentModel.id}`];
			if (usage && typeof usage.percent === "number") {
				// 1% precision; pi-status sits after the last user message and other
				// fields change each turn, so rounding gains nothing.
				const pct = Math.min(100, Math.round(usage.percent));
				parts.push(`context=${pct}%`);
			}

			// Tool-output share — proxy for context noise density. High share (>40%)
			// hints the agent to externalize tool results (note to disk) instead of
			// keeping them inline. Char-count is good enough; we don't need real tokens.
			let totalChars = 0;
			let toolChars = 0;
			for (const m of messages as any[]) {
				let mc = 0;
				if (typeof m.content === "string") mc = m.content.length;
				else if (Array.isArray(m.content)) {
					for (const part of m.content) {
						if (typeof part?.text === "string") mc += part.text.length;
						else if (typeof part?.content === "string") mc += part.content.length;
					}
				}
				totalChars += mc;
				if (m.role === "toolResult") toolChars += mc;
			}
			if (totalChars > 0) {
				const toolPct = Math.round((toolChars / totalChars) * 100);
				parts.push(`tool=${toolPct}%`);
			}

			// Anchor info — only consider anchors on the current branch so status
			// reflects where the agent actually is, not orphaned anchors from abandoned branches.
			const branchEntries = ctx.sessionManager?.getBranch?.() ?? [];
			const anchors = branchEntries.filter(isAnchorEntry);
			if (anchors.length > 0) {
				const latestAnchor = anchors[anchors.length - 1] as any;
				const latestName = latestAnchor?.message?.details?.anchor?.name;
				if (latestName) {
					// Distance to the most recent anchor, measured in branch entries.
					// Long distance (e.g. -15) reminds the agent to checkpoint progress
					// rather than risk a long un-anchored chain that's hard to pivot back to.
					const latestIdx = branchEntries.indexOf(latestAnchor);
					const distance = latestIdx >= 0 ? branchEntries.length - 1 - latestIdx : 0;
					parts.push(`anchor=${latestName} (-${distance})`);
				}
			}

			// Anchor reminder — only once per session
			if (!anchorReminderSent) {
				if (anchors.length > 0) {
					anchorReminderSent = true;
				} else if (branchEntries.length > 10) {
					parts.push(`hint=no-anchors-yet`);
					anchorReminderSent = true;
				}
			}

			const statusMsg = {
				role: "custom",
				customType: "pi-status",
				content: `[pi-control] ${parts.join(" | ")}`,
				display: false,
				timestamp: Date.now(),
			} as any;

			// Find last user message and insert AFTER it.
			let inserted = false;
			for (let i = messages.length - 1; i >= 0; i--) {
				if ((messages[i] as any).role === "user") {
					messages.splice(i + 1, 0, statusMsg);
					inserted = true;
					break;
				}
			}
			if (!inserted) messages.push(statusMsg);
			modified = true;
		}

		if (modified) return { messages };
	});

	pi.on("session_before_tree", async (event) => {
		const pivot = getActivePivot();
		if (!pivot) return;
		if (event.preparation.targetId !== pivot.targetId) return;

		const sourceLeaf = event.preparation.oldLeafId;
		const sourceInfo = `Pivoted from: ${sourceLeaf?.slice(0, 8) ?? "unknown"}`;
		return {
			summary: {
				summary: `${sourceInfo}\n\n${pivot.carryover}`,
			},
		};
	});

	// ── Execute pending actions after agent fully settles ──
	pi.on("agent_end", async (_event, ctx) => {
		if (!hasPending()) return;
		const notify = ctx.hasUI
			? (msg: string, level: "info" | "warning" | "error") => ctx.ui.notify(msg, level)
			: undefined;
		const runtime = {
			sendFollowUp: (msg: string) => pi.sendUserMessage(msg, { deliverAs: "followUp" }),
		};
		setTimeout(() => {
			runPending(notify, runtime).catch((e) => {
				if (notify) notify(`pi-control runPending error: ${e}`, "error");
				else console.error("[pi-control] runPending error:", e);
			});
		}, 0);
	});

	// Warn once if patch failed or command context was never bound.
	let warnedOnce = false;
	pi.on("session_start", async (_event, ctx) => {
		anchorReminderSent = false;
		if (warnedOnce) return;
		if (!patchOk) {
			warnedOnce = true;
			if (ctx.hasUI) ctx.ui.notify("pi-control: failed to patch ExtensionRunner — resume/new/navigate/fork/pivot will fall back to built-in commands", "warning");
		} else if (!isArmed()) {
			warnedOnce = true;
			if (ctx.hasUI) ctx.ui.notify("pi-control: command context not captured — resume/new/navigate/fork/pivot will fall back to built-in commands", "warning");
		}
	});

	// Clear stale pending state on session shutdown.
	pi.on("session_shutdown", async () => {
		anchorReminderSent = false;
		clearPending();
	});
}
