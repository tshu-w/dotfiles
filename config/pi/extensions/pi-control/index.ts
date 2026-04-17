/**
 * Pi Control — self-control layer for pi.
 *
 * 3 router tools, always active:
 *   sessions  — session management (info, search, resume, new, name, queue_message)
 *   tree      — session entry operations (list, search, labels, navigate, fork, compact)
 *   models    — model listing, switching, and consultation
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
	// Must run before bindCommandContext() is called (during extension load = OK).
	// Private API hack — upstream equivalent: pi.runWhenIdle() (#2023).
	const patchOk = patchBindCommandContext();

	registerSessionsRouter(pi);
	registerTreeRouter(pi);
	registerModelsRouter(pi);

	// Execute pending session/navigation actions after agent fully settles.
	// Use agent_end (not turn_end) so the agent loop has exited.
	// Defer via setTimeout(0) so prompt() returns and the editor re-enables
	// before we switch sessions — otherwise prompt() hangs forever.
	pi.on("agent_end", async (_event, ctx) => {
		if (!hasPending()) return;
		const notify = ctx.hasUI
			? (msg: string, level: "info" | "warning" | "error") => ctx.ui.notify(msg, level)
			: undefined;
		setTimeout(() => { runPending(notify).catch(() => {}); }, 0);
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
