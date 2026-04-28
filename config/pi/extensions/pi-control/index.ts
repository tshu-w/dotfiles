/**
 * Pi Control — self-control layer for pi.
 *
 * 3 router tools, always active:
 *   sessions  — session management (info, search, resume, new, name, queue_message, reload)
 *   tree      — session entry operations (list, search, labels, set_label, navigate, fork, compact)
 *   models    — model listing, switching, and consultation
 *
 * Registers a context event hook to inject pi-status ambient metadata
 * (current model + bucketized context usage) after the last user message.
 *
 * Uses a private API hack to capture command-only closures from
 * ExtensionRunner.prototype.bindCommandContext, then executes
 * pending session/navigation actions after agent_end + setTimeout(0).
 * Upstream equivalent: pi.runWhenIdle() (#2023).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { patchBindCommandContext, runPending, clearPending, isArmed, hasPending } from "./command-actions.js";
import { registerSessionsRouter } from "./session.js";
import { registerTreeRouter } from "./tree.js";
import { registerModelsRouter } from "./model.js";

export default function (pi: ExtensionAPI) {
	// Patch ExtensionRunner to auto-capture command context actions.
	const patchOk = patchBindCommandContext();

	registerSessionsRouter(pi);
	registerTreeRouter(pi);
	registerModelsRouter(pi);

	// ── Context event: inject pi-status ambient metadata ──
	pi.on("context", async (event, ctx) => {
		const messages = event.messages;
		if (!messages || messages.length === 0) return;

		const currentModel = ctx.model;
		if (!currentModel) return;

		const usage = ctx.getContextUsage?.();
		const parts: string[] = [`model=${currentModel.provider}/${currentModel.id}`];
		if (usage && typeof usage.percent === "number") {
			// Bucketize to 10% steps so the value is stable across small context growth
			// and serves as a clear threshold signal rather than noisy exact percentages.
			const bucket = Math.min(100, Math.round(usage.percent / 10) * 10);
			parts.push(`context=${bucket}%`);
		}

		const statusMsg = {
			role: "custom",
			customType: "pi-status",
			content: `[pi-control] ${parts.join(" | ")}`,
			display: false,
			timestamp: Date.now(),
		} as any;

		// Insert status as a standalone message AFTER the last user message.
		// Rationale: putting pi-status at the tail keeps the request prefix identical
		// to the no-status baseline, so prefix cache hits are preserved across turns.
		let inserted = false;
		for (let i = messages.length - 1; i >= 0; i--) {
			if ((messages[i] as any).role === "user") {
				messages.splice(i + 1, 0, statusMsg);
				inserted = true;
				break;
			}
		}
		if (!inserted) messages.push(statusMsg);

		return { messages };
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
		if (warnedOnce) return;
		if (!patchOk) {
			warnedOnce = true;
			if (ctx.hasUI) ctx.ui.notify("pi-control: failed to patch ExtensionRunner — resume/new/navigate/fork will fall back to built-in commands", "warning");
		} else if (!isArmed()) {
			warnedOnce = true;
			if (ctx.hasUI) ctx.ui.notify("pi-control: command context not captured — resume/new/navigate/fork will fall back to built-in commands", "warning");
		}
	});

	// Clear stale pending state on session shutdown.
	pi.on("session_shutdown", async () => {
		clearPending();
	});
}
