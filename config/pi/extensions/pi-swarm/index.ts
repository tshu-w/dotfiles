import {
	createAgentSession,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
	Canopy,
	TreeScheduler,
	createChildResourceLoader,
	type AgentCompletion,
	type CanopyHost,
	type ChildRecord,
	type PreparedChild,
	type SpawnRequest,
} from "./canopy.js";
import { renderToolCall } from "./tool-call-render.js";

const MAX_CONCURRENT = 3;
const CHILD_STATE_TYPE = "pi-swarm-child";
const NODE_META_TYPE = "pi-swarm-node";
const USAGE_STATE_TYPE = "pi-swarm-usage";
const SWARM_EXTENSION_PATH = fileURLToPath(import.meta.url);

interface NodeMetadata {
	version: 1;
	rootId: string;
	parentId?: string;
}

interface PersistedChildState {
	version: 1;
	child: ChildRecord;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface PersistedUsageState {
	version: 1;
	usage: UsageTotals;
}

interface ChildRuntime {
	session: AgentSession;
}

interface PreparedRuntime {
	sessionManager: SessionManager;
	model: NonNullable<ExtensionContext["model"]>;
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}

interface SwarmController {
	stopDescendants(): Promise<void>;
	waitForDescendants(): Promise<void>;
	hasRunningDescendants(): boolean;
	persistUsage(usage: UsageTotals): void;
}

interface SharedRuntime {
	scheduler: TreeScheduler;
	controllers: Map<string, SwarmController>;
	usageByRoot: Map<string, UsageTotals>;
}

const SHARED_RUNTIME_KEY = Symbol.for("pi-swarm:runtime");
const globals = globalThis as Record<symbol, unknown>;
const shared = (globals[SHARED_RUNTIME_KEY] ??= {
	scheduler: new TreeScheduler(),
	controllers: new Map<string, SwarmController>(),
	usageByRoot: new Map<string, UsageTotals>(),
}) as SharedRuntime;
shared.usageByRoot ??= new Map<string, UsageTotals>();

function childSessionDirectory(cwd: string, agentDir: string): string {
	const resolvedCwd = path.resolve(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(path.resolve(agentDir), "sessions", safePath, "subagents");
}

function persistPreparedSession(sessionManager: SessionManager, cwd: string): SessionManager {
	const sessionFile = sessionManager.getSessionFile()!;
	mkdirSync(path.dirname(sessionFile), { recursive: true });
	const entries = [sessionManager.getHeader(), ...sessionManager.getEntries()];
	writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
	return SessionManager.open(sessionFile, path.dirname(sessionFile), cwd);
}

function nodeMetadata(ctx: ExtensionContext): NodeMetadata | undefined {
	let metadata: NodeMetadata | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== NODE_META_TYPE) continue;
		const candidate = entry.data as Partial<NodeMetadata> | undefined;
		if (candidate?.version === 1 && typeof candidate.rootId === "string") {
			metadata = candidate as NodeMetadata;
		}
	}
	return metadata;
}

function restoredChildren(ctx: ExtensionContext): ChildRecord[] {
	const records = new Map<string, ChildRecord>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== CHILD_STATE_TYPE) continue;
		const state = entry.data as Partial<PersistedChildState> | undefined;
		const child = state?.child;
		if (state?.version !== 1 || !child || typeof child.id !== "string" || typeof child.sessionFile !== "string") continue;
		records.set(child.id, child as ChildRecord);
	}
	return [...records.values()];
}

function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function restoredUsage(ctx: ExtensionContext): UsageTotals {
	let usage = emptyUsage();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== USAGE_STATE_TYPE) continue;
		const state = entry.data as Partial<PersistedUsageState> | undefined;
		if (state?.version === 1 && state.usage) usage = { ...emptyUsage(), ...state.usage };
	}
	return usage;
}

function addUsage(rootId: string, delta: UsageTotals): void {
	const current = shared.usageByRoot.get(rootId) ?? emptyUsage();
	const next = {
		input: current.input + delta.input,
		output: current.output + delta.output,
		cacheRead: current.cacheRead + delta.cacheRead,
		cacheWrite: current.cacheWrite + delta.cacheWrite,
		cost: current.cost + delta.cost,
		turns: current.turns + delta.turns,
	};
	shared.usageByRoot.set(rootId, next);
	shared.controllers.get(rootId)?.persistUsage(next);
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageTotals): string {
	return `${usage.turns} turns ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)} $${usage.cost.toFixed(4)}`;
}

function resolveProjectTrust(cwd: string, current: ExtensionContext, agentDir: string): boolean {
	if (path.resolve(cwd) === path.resolve(current.cwd)) return current.isProjectTrusted();
	const untrusted = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const policy = untrusted.getDefaultProjectTrust();
	if (policy === "always") return true;
	if (policy === "never") return false;
	throw new Error(`Project trust for ${cwd} requires interactive confirmation. Open that directory in Pi first or set defaultProjectTrust.`);
}

function finalCompletion(session: AgentSession): Omit<AgentCompletion, "id"> {
	const assistant = [...session.messages].reverse().find((message: any) => message?.role === "assistant") as any;
	if (!assistant) return { status: "failed", error: "Child settled without an assistant response" };
	if (assistant.stopReason === "aborted") return { status: "stopped" };
	if (assistant.stopReason === "error") {
		return { status: "failed", error: assistant.errorMessage || "Child model request failed" };
	}
	const content = assistant.content;
	const result = typeof content === "string"
		? content
		: Array.isArray(content)
			? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
			: "";
	return { status: "completed", result };
}

function completionMessage(completion: AgentCompletion): string {
	const lines = [`Agent ${completion.id} ${completion.status}.`];
	if (completion.result !== undefined) lines.push(completion.result);
	if (completion.error !== undefined) lines.push(`Error: ${completion.error}`);
	return lines.join("\n\n");
}

export class PiCanopyHost implements CanopyHost {
	private pi: ExtensionAPI;
	private agentDir: string;
	private rootId: string;
	private parentId: string;
	private current?: ExtensionContext;
	private prepared = new Map<string, PreparedRuntime>();
	private runtimes = new Map<string, ChildRuntime>();
	private initializing = new Map<string, Promise<ChildRuntime>>();
	private turns = new Map<string, { cancelled: boolean; done: Promise<void>; resolveDone(): void }>();

	constructor(pi: ExtensionAPI, agentDir: string, rootId: string, parentId: string) {
		this.pi = pi;
		this.agentDir = agentDir;
		this.rootId = rootId;
		this.parentId = parentId;
	}

	setContext(ctx: ExtensionContext): void {
		this.current = ctx;
	}

	prepareChild(request: SpawnRequest): PreparedChild {
		const ctx = this.requireContext();
		const model = ctx.model;
		if (!model) throw new Error("Cannot spawn an agent without an active model");
		const cwd = path.resolve(request.cwd ?? ctx.cwd);
		resolveProjectTrust(cwd, ctx, this.agentDir);
		const sessionManager = SessionManager.create(cwd, childSessionDirectory(cwd, this.agentDir), {
			parentSession: ctx.sessionManager.getSessionFile(),
		});
		const id = sessionManager.getSessionId();
		sessionManager.appendCustomEntry(NODE_META_TYPE, {
			version: 1,
			rootId: this.rootId,
			parentId: this.parentId,
		} satisfies NodeMetadata);
		sessionManager.appendModelChange(model.provider, model.id);
		sessionManager.appendThinkingLevelChange(this.pi.getThinkingLevel());
		if ((request.context ?? "fresh") === "fork") {
			// This is an LLM-context snapshot, so summary roles intentionally become
			// ordinary message entries rather than child-session compaction metadata.
			for (const message of ctx.sessionManager.buildSessionContext().messages) {
				sessionManager.appendMessage(structuredClone(message) as any);
			}
		}
		this.prepared.set(id, {
			sessionManager: persistPreparedSession(sessionManager, cwd),
			model,
			thinkingLevel: this.pi.getThinkingLevel(),
		});
		return { id, sessionFile: sessionManager.getSessionFile()!, cwd };
	}

	async runChild(child: ChildRecord, message: string): Promise<Omit<AgentCompletion, "id">> {
		let resolveDone!: () => void;
		const turn = {
			cancelled: false,
			done: new Promise<void>((resolve) => { resolveDone = resolve; }),
			resolveDone,
		};
		this.turns.set(child.id, turn);
		let runtime: ChildRuntime | undefined;
		let before: ReturnType<AgentSession["getSessionStats"]> | undefined;
		try {
			runtime = await this.ensureRuntime(child);
			before = runtime.session.getSessionStats();
			if (turn.cancelled) return { status: "stopped" };
			await runtime.session.prompt(message);
			await runtime.session.waitForIdle();

			while (true) {
				// Descendant completion delivery runs in a microtask. Yielding a macrotask
				// lets sendMessage synchronously mark the follow-up agent run as active.
				const controller = shared.controllers.get(child.id);
				if (controller?.hasRunningDescendants()) await controller.waitForDescendants();
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				await runtime.session.waitForIdle();
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				if (!controller?.hasRunningDescendants() && runtime.session.isIdle) break;
			}
			return finalCompletion(runtime.session);
		} finally {
			turn.resolveDone();
			if (this.turns.get(child.id) === turn) this.turns.delete(child.id);
			if (runtime && before) {
				const after = runtime.session.getSessionStats();
				addUsage(this.rootId, {
					input: Math.max(0, after.tokens.input - before.tokens.input),
					output: Math.max(0, after.tokens.output - before.tokens.output),
					cacheRead: Math.max(0, after.tokens.cacheRead - before.tokens.cacheRead),
					cacheWrite: Math.max(0, after.tokens.cacheWrite - before.tokens.cacheWrite),
					cost: Math.max(0, after.cost - before.cost),
					turns: Math.max(0, after.assistantMessages - before.assistantMessages),
				});
			}
		}
	}

	async stopChild(child: ChildRecord): Promise<void> {
		const turn = this.turns.get(child.id);
		if (turn) turn.cancelled = true;
		const errors: unknown[] = [];
		try {
			await shared.controllers.get(child.id)?.stopDescendants();
		} catch (error) {
			errors.push(error);
		}
		const runtime = this.runtimes.get(child.id) ?? await this.initializing.get(child.id)?.catch(() => undefined);
		let abortFailed = false;
		if (runtime) {
			try {
				await runtime.session.abort();
			} catch (error) {
				abortFailed = true;
				errors.push(error);
			}
		}
		if (turn && !abortFailed) await turn.done;
		if (errors.length > 0) throw new AggregateError(errors, `Failed to stop child agent ${child.id}`);
	}

	async shutdownChild(child: ChildRecord): Promise<void> {
		const runtime = this.runtimes.get(child.id) ?? await this.initializing.get(child.id)?.catch(() => undefined);
		if (!runtime) return;
		try {
			await runtime.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			runtime.session.dispose();
			this.runtimes.delete(child.id);
			shared.controllers.delete(child.id);
		}
	}

	persist(child: ChildRecord): void {
		this.pi.appendEntry(CHILD_STATE_TYPE, { version: 1, child } satisfies PersistedChildState);
	}

	deliver(completion: AgentCompletion): void {
		this.pi.sendMessage({
			customType: "pi-swarm-completion",
			content: completionMessage(completion),
			display: true,
			details: completion,
		}, { triggerTurn: true, deliverAs: "followUp" });
	}

	private requireContext(): ExtensionContext {
		if (!this.current) throw new Error("Pi Swarm is not initialized");
		return this.current;
	}

	private ensureRuntime(child: ChildRecord): Promise<ChildRuntime> {
		const existing = this.runtimes.get(child.id);
		if (existing) return Promise.resolve(existing);
		const pending = this.initializing.get(child.id);
		if (pending) return pending;
		const creating = this.createRuntime(child).finally(() => this.initializing.delete(child.id));
		this.initializing.set(child.id, creating);
		return creating;
	}

	private async createRuntime(child: ChildRecord): Promise<ChildRuntime> {
		const ctx = this.requireContext();
		const prepared = this.prepared.get(child.id);
		const projectTrusted = resolveProjectTrust(child.cwd, ctx, this.agentDir);
		const settingsManager = SettingsManager.create(child.cwd, this.agentDir, { projectTrusted });
		const extensionPaths = [SWARM_EXTENSION_PATH];
		const webExtensionPath = path.join(this.agentDir, "extensions", "pi-web", "index.ts");
		if (existsSync(webExtensionPath)) extensionPaths.push(webExtensionPath);
		const resourceLoader = await createChildResourceLoader({
			cwd: child.cwd,
			agentDir: this.agentDir,
			settingsManager,
			extensionPaths,
		});
		const extensionErrors = resourceLoader.getExtensions().errors;
		if (extensionErrors.length > 0) {
			throw new Error(`Child extension loading failed: ${extensionErrors.map((error) => `${error.path}: ${error.error}`).join("; ")}`);
		}
		const sessionManager = prepared?.sessionManager ?? SessionManager.open(child.sessionFile, path.dirname(child.sessionFile), child.cwd);
		const created = await createAgentSession({
			cwd: child.cwd,
			agentDir: this.agentDir,
			settingsManager,
			resourceLoader,
			sessionManager,
			model: prepared?.model,
			thinkingLevel: prepared?.thinkingLevel,
			tools: this.pi.getActiveTools(),
			sessionStartEvent: { type: "session_start", reason: prepared ? "new" : "resume" },
		});
		if (!created.session.model) {
			created.session.dispose();
			throw new Error(created.modelFallbackMessage ?? "No model available for child");
		}
		try {
			await created.session.bindExtensions({ mode: "print" });
		} catch (error) {
			try {
				await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				created.session.dispose();
			}
			throw error;
		}
		const runtime = { session: created.session };
		this.runtimes.set(child.id, runtime);
		this.prepared.delete(child.id);
		return runtime;
	}
}

function rejectFields(params: Record<string, unknown>, action: string, fields: string[]): void {
	const present = fields.filter((field) => params[field] !== undefined);
	if (present.length > 0) throw new Error(`${action} does not accept: ${present.join(", ")}`);
}

function validateTimeout(value: unknown): number {
	if (value === undefined) return 30;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error("wait timeout must be a finite non-negative number of seconds");
	}
	return value;
}

function jsonResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}

export default function piSwarm(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let canopy: Canopy | undefined;
	let host: PiCanopyHost | undefined;
	let sessionId: string | undefined;
	let treeRootId: string | undefined;
	let controller: SwarmController | undefined;

	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		const metadata = nodeMetadata(ctx);
		const rootId = metadata?.rootId ?? sessionId;
		treeRootId = rootId;
		if (rootId === sessionId) shared.usageByRoot.set(rootId, restoredUsage(ctx));
		host = new PiCanopyHost(pi, agentDir, rootId, sessionId);
		host.setContext(ctx);
		canopy = new Canopy(host, shared.scheduler, { rootId, maxConcurrent: MAX_CONCURRENT });
		canopy.restore(restoredChildren(ctx));
		controller = {
			stopDescendants: () => canopy!.stopAll(),
			waitForDescendants: () => canopy!.waitForIdle(),
			hasRunningDescendants: () => canopy!.hasRunning(),
			persistUsage: (usage) => {
				if (rootId === sessionId) pi.appendEntry(USAGE_STATE_TYPE, { version: 1, usage } satisfies PersistedUsageState);
			},
		};
		shared.controllers.set(sessionId, controller);
		setTimeout(() => canopy?.deliverPending(), 0);
	});

	pi.on("session_shutdown", async () => {
		try {
			await canopy?.shutdown();
		} finally {
			if (sessionId && shared.controllers.get(sessionId) === controller) shared.controllers.delete(sessionId);
			if (sessionId && sessionId === treeRootId) shared.usageByRoot.delete(sessionId);
			canopy = undefined;
			host = undefined;
			treeRootId = undefined;
		}
	});

	const AgentParams = Type.Object({
		action: StringEnum(["spawn", "send", "wait", "stop"] as const, { description: "Action to perform" }),
		message: Type.Optional(Type.String({ description: "Task for spawn, or next-turn message for send." })),
		context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: 'Spawn context. "fresh" (default) receives only the task message plus normal Pi resources; "fork" snapshots the parent conversation context.' })),
		cwd: Type.Optional(Type.String({ description: "Child working directory. Default: current cwd. Children share its filesystem with the parent." })),
		id: Type.Optional(Type.String({ description: "Child ID for send or stop." })),
		ids: Type.Optional(Type.Array(Type.String(), { description: "Child IDs for wait. Omit to capture all currently running children." })),
		timeout: Type.Optional(Type.Number({ description: "Wait timeout in seconds. Default: 30. Timeout does not stop agents." })),
	});

	pi.registerTool({
		name: "agent",
		label: "Agent",
		description: [
			"Delegate and coordinate work with child agents.",
			"spawn: start a child and return its ID immediately.",
			"send: continue a completed, failed, or stopped child, or queue a FIFO follow-up for a running child; queued turn results are delivered together after the queue drains.",
			"wait: wait for children without stopping them on timeout.",
			"stop: recursively stop a child subtree, clear queued follow-ups, and preserve transcripts.",
		].join(" "),
		promptSnippet: "Delegate and coordinate work with child agents",
		promptGuidelines: [
			"Use agent(action='spawn', message=...) to delegate concrete, bounded work.",
			"Children share the selected cwd and filesystem, so avoid overlapping edits.",
			"Default to context='fresh' with a self-contained message. Use context='fork' only when the child needs a snapshot of the parent conversation.",
			"Issue multiple spawn calls for parallel work; use wait only when the current turn must aggregate child results.",
			"Address only children created by the current agent; each child can use agent to coordinate its own children.",
			"Use send for ordered follow-up work and stop for immediate interruption.",
		],
		parameters: AgentParams,
		renderCall(args, theme, context) {
			return renderToolCall("agent", args, theme, !context.isPartial);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!canopy || !host) throw new Error("Pi Swarm is not initialized");
			host.setContext(ctx);
			switch (params.action) {
				case "spawn": {
					rejectFields(params, "spawn", ["id", "ids", "timeout"]);
					if (!params.message) throw new Error("spawn requires message");
					return jsonResult(canopy.spawn({ message: params.message, context: params.context, cwd: params.cwd }));
				}
				case "send": {
					rejectFields(params, "send", ["context", "cwd", "ids", "timeout"]);
					if (!params.id || !params.message) throw new Error("send requires id and message");
					canopy.send(params.id, params.message);
					return { content: [{ type: "text", text: "Message accepted." }], details: { id: params.id } };
				}
				case "wait": {
					rejectFields(params, "wait", ["message", "context", "cwd", "id"]);
					return jsonResult(await canopy.wait({ ids: params.ids, timeoutSeconds: validateTimeout(params.timeout), signal }));
				}
				case "stop": {
					rejectFields(params, "stop", ["message", "context", "cwd", "ids", "timeout"]);
					if (!params.id) throw new Error("stop requires id");
					return jsonResult(await canopy.stop(params.id));
				}
			}
		},
	});

	pi.registerCommand("agents", {
		description: "List child agents and tree-level usage",
		handler: async (_args, ctx) => {
			const children = canopy?.list() ?? [];
			const usage = treeRootId ? shared.usageByRoot.get(treeRootId) ?? emptyUsage() : emptyUsage();
			const lines = [`Tree usage: ${formatUsage(usage)}`];
			if (children.length === 0) lines.push("No child agents.");
			else lines.push(...children.map((child) => `${child.id}  ${child.status}${child.queuedMessages?.length ? `  queued=${child.queuedMessages.length}` : ""}  ${child.cwd}`));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
