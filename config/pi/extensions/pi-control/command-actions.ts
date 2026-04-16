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

export interface CommandOps {
	switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
	newSession: (options?: { parentSession?: string; setup?: any }) => Promise<{ cancelled: boolean }>;
	navigateTree: (targetId: string, options?: {
		summarize?: boolean;
		customInstructions?: string;
		replaceInstructions?: boolean;
		label?: string;
	}) => Promise<{ cancelled: boolean }>;
	fork: (entryId: string) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

// ── State ───────────────────────────────────────────────────

let _ops: CommandOps | null = null;

let _pendingResume: string | null = null;
let _pendingNew: { parentSession?: string } | null = null;
let _pendingNav: { targetId: string; summarize?: boolean; customInstructions?: string } | null = null;
let _pendingFork: string | null = null;

// ── Accessors ───────────────────────────────────────────────

export function isArmed(): boolean { return _ops !== null; }
export function hasPending(): boolean { return _pendingResume !== null || _pendingNew !== null || _pendingNav !== null || _pendingFork !== null; }

export function setPendingResume(file: string) { _pendingResume = file; }
export function setPendingNew(opts: { parentSession?: string }) { _pendingNew = opts; }
export function setPendingNav(opts: { targetId: string; summarize?: boolean; customInstructions?: string }) { _pendingNav = opts; }
export function setPendingFork(id: string) { _pendingFork = id; }

function consumePendingResume() { const v = _pendingResume; _pendingResume = null; return v; }
function consumePendingNew() { const v = _pendingNew; _pendingNew = null; return v; }
function consumePendingNav() { const v = _pendingNav; _pendingNav = null; return v; }
function consumePendingFork() { const v = _pendingFork; _pendingFork = null; return v; }

export function clearPending() {
	_pendingResume = null;
	_pendingNew = null;
	_pendingNav = null;
	_pendingFork = null;
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
): Promise<void> {
	if (!_ops) return;

	const resume = consumePendingResume();
	if (resume) {
		try {
			const r = await _ops.switchSession(resume);
			if (r.cancelled) notify?.("Session switch cancelled", "warning");
		} catch (e) { notify?.(`Session switch failed: ${e}`, "error"); }
		return;
	}

	const newOpts = consumePendingNew();
	if (newOpts) {
		try {
			const r = await _ops.newSession(newOpts);
			if (r.cancelled) notify?.("New session cancelled", "warning");
		} catch (e) { notify?.(`New session failed: ${e}`, "error"); }
		return;
	}

	const nav = consumePendingNav();
	if (nav) {
		try {
			const r = await _ops.navigateTree(nav.targetId, {
				summarize: nav.summarize,
				customInstructions: nav.customInstructions,
			});
			if (r.cancelled) notify?.("Navigation cancelled", "warning");
		} catch (e) { notify?.(`Navigation failed: ${e}`, "error"); }
		return;
	}

	const fork = consumePendingFork();
	if (fork) {
		try {
			const r = await _ops.fork(fork);
			if (r.cancelled) notify?.("Fork cancelled", "warning");
		} catch (e) { notify?.(`Fork failed: ${e}`, "error"); }
		return;
	}
}
