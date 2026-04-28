/**
 * Private API hack: auto-capture command-only closures from ExtensionRunner.
 *
 * pi's public API only exposes switchSession/newSession/navigateTree/fork/reload
 * on ExtensionCommandContext (command handlers), not on ExtensionContext (tools/events).
 * We patch ExtensionRunner.prototype.bindCommandContext to capture these closures
 * when the runtime binds them, then execute pending actions after agent_end + setTimeout(0).
 *
 * This is the userland polyfill for upstream pi.runWhenIdle() (#2023).
 */

import { ExtensionRunner } from "@mariozechner/pi-coding-agent";

// ── Types ───────────────────────────────────────────────────

/**
 * A pending deferred action. Discriminated on `kind`.
 *
 * At most one action can be pending at a time — enforced by `setPending()`.
 * The exhaustive switch in `runPending()` guarantees every kind is handled.
 */
export type PendingAction =
	| { kind: "resume"; file: string; message?: string }
	| { kind: "new"; parentSession?: string; message?: string }
	| { kind: "nav"; targetId: string; summarize?: boolean; customInstructions?: string; message?: string }
	| { kind: "fork"; id: string; message?: string }
	| { kind: "pivot"; targetId: string; carryover: string; message?: string }
	| { kind: "reload"; message?: string };

/** The pivot action payload. Useful for hooks that introspect the active pivot. */
export type PendingPivot = Extract<PendingAction, { kind: "pivot" }>;

export interface RuntimeContext {
	sendFollowUp: (msg: string) => void;
}

export interface CommandOps {
	switchSession: (sessionPath: string, options?: {
		withSession?: (ctx: any) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	newSession: (options?: {
		parentSession?: string;
		setup?: any;
		withSession?: (ctx: any) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	navigateTree: (targetId: string, options?: {
		summarize?: boolean;
		customInstructions?: string;
		replaceInstructions?: boolean;
		label?: string;
	}) => Promise<{ cancelled: boolean }>;
	fork: (entryId: string, options?: {
		position?: "before" | "at";
		withSession?: (ctx: any) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

// ── State ───────────────────────────────────────────────────

let _ops: CommandOps | null = null;
let _pending: PendingAction | null = null;
let _activePivot: PendingPivot | null = null;

// ── Accessors ───────────────────────────────────────────────

export function isArmed(): boolean { return _ops !== null; }
export function hasPending(): boolean { return _pending !== null; }
export function getActivePivot(): PendingPivot | null { return _activePivot; }

export function clearPending(): void {
	_pending = null;
	_activePivot = null;
}

/**
 * Router-facing helper: dispatch a pending action.
 *
 * Callers do action-specific validation first, then hand off to scheduleAction
 * which handles the isArmed / hasPending / set / response boilerplate.
 */
export interface ScheduleParams {
	/** Short hint pointing at the built-in fallback command, e.g. "Use built-in `/resume` instead." */
	fallbackHint: string;
	/** The action to schedule. */
	action: PendingAction;
	/** Success text shown to the model when the action was scheduled. */
	successText: string;
	/** Structured details echoed back to the model. */
	details?: Record<string, any>;
}

export function scheduleAction(params: ScheduleParams): { content: Array<{ type: "text"; text: string }>; details: Record<string, any> } {
	if (!isArmed()) {
		return {
			content: [{ type: "text", text: `Command context not captured. ${params.fallbackHint}` }],
			details: {},
		};
	}
	if (hasPending()) {
		return {
			content: [{ type: "text", text: `Another pending action (${_pending?.kind}) is already scheduled. Wait for the current turn to finish.` }],
			details: {},
		};
	}
	_pending = params.action;
	return {
		content: [{ type: "text", text: params.successText }],
		details: params.details ?? {},
	};
}

// ── Patch ───────────────────────────────────────────────────

let _patched = false;

export function patchBindCommandContext(): boolean {
	if (_patched) return true;
	try {
		const orig = ExtensionRunner.prototype.bindCommandContext;
		if (typeof orig !== "function") return false;

		ExtensionRunner.prototype.bindCommandContext = function (actions: any) {
			_ops = actions ? {
				switchSession: actions.switchSession,
				newSession: actions.newSession,
				navigateTree: actions.navigateTree,
				fork: actions.fork,
				reload: actions.reload,
			} : null;
			return orig.call(this, actions);
		};

		_patched = true;
		return true;
	} catch {
		return false;
	}
}

// ── Execute pending actions ─────────────────────────────────

export async function runPending(
	notify?: (msg: string, level: "info" | "warning" | "error") => void,
	runtime?: RuntimeContext,
): Promise<void> {
	if (!_ops) return;
	// Consume before awaiting so a long-running action does not block further
	// scheduling. During the await below, `hasPending()` returns false and the
	// session is typically being replaced anyway.
	const action = _pending;
	_pending = null;
	if (!action) return;

	const reportError = (message: string, error?: unknown) => {
		if (notify) {
			notify(error === undefined ? message : `${message}: ${error}`, "error");
			return;
		}
		if (error === undefined) console.error(`[pi-control] ${message}`);
		else console.error(`[pi-control] ${message}:`, error);
	};

	// Builds a withSession option that injects `message` into the replaced session.
	const withMessage = (message: string | undefined) => {
		if (!message) return undefined;
		return async (newCtx: any) => {
			await newCtx.sendUserMessage(message);
		};
	};

	switch (action.kind) {
		case "resume": {
			try {
				const opts: any = {};
				const ws = withMessage(action.message);
				if (ws) opts.withSession = ws;
				const r = await _ops.switchSession(action.file, opts);
				if (r.cancelled) notify?.("Session switch cancelled", "warning");
			} catch (e) { reportError("Session switch failed", e); }
			return;
		}

		case "new": {
			try {
				const opts: any = { parentSession: action.parentSession };
				const ws = withMessage(action.message);
				if (ws) opts.withSession = ws;
				const r = await _ops.newSession(opts);
				if (r.cancelled) notify?.("New session cancelled", "warning");
			} catch (e) { reportError("New session failed", e); }
			return;
		}

		case "nav": {
			try {
				const r = await _ops.navigateTree(action.targetId, {
					summarize: action.summarize,
					customInstructions: action.customInstructions,
				});
				if (r.cancelled) notify?.("Navigation cancelled", "warning");
				else if (action.message && runtime) runtime.sendFollowUp(action.message);
			} catch (e) { reportError("Navigation failed", e); }
			return;
		}

		case "fork": {
			try {
				const opts: any = {};
				const ws = withMessage(action.message);
				if (ws) opts.withSession = ws;
				const r = await _ops.fork(action.id, opts);
				if (r.cancelled) notify?.("Fork cancelled", "warning");
			} catch (e) { reportError("Fork failed", e); }
			return;
		}

		case "pivot": {
			if (!runtime) {
				reportError("Pivot failed: runtime context not available");
				return;
			}
			try {
				// Let navigateTree build the new branch summary so agent state stays in sync.
				_activePivot = action;
				const r = await _ops.navigateTree(action.targetId, { summarize: true });
				if (r.cancelled) notify?.("Pivot cancelled", "warning");
				else {
					const msg = action.message ?? "Pivot complete. Continue from the target anchor.";
					runtime.sendFollowUp(msg);
				}
			} catch (e) { reportError("Pivot failed", e); }
			finally { _activePivot = null; }
			return;
		}

		case "reload": {
			try {
				await _ops.reload();
				if (action.message && runtime) runtime.sendFollowUp(action.message);
			} catch (e) { reportError("Reload failed", e); }
			return;
		}

		default: {
			// Exhaustiveness: if a new kind is added without a case, TS surfaces it here.
			const _exhaustive: never = action;
			return _exhaustive;
		}
	}
}
