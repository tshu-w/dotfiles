import {
	DefaultResourceLoader,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface ChildResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	extensionPaths: string[];
}

export async function createChildResourceLoader(options: ChildResourceLoaderOptions): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
		noExtensions: true,
		additionalExtensionPaths: options.extensionPaths,
	});
	await loader.reload();
	return loader;
}

export type AgentStatus = "completed" | "failed" | "stopped";
type ChildStatus = "running" | AgentStatus;

export interface AgentCompletion {
	id: string;
	status: AgentStatus;
	result?: string;
	error?: string;
}

export interface ChildRecord {
	id: string;
	sessionFile: string;
	cwd: string;
	status: ChildStatus;
	result?: string;
	error?: string;
	queuedMessages?: string[];
	consumed: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface PreparedChild {
	id: string;
	sessionFile: string;
	cwd: string;
}

export interface SpawnRequest {
	message: string;
	context?: "fresh" | "fork";
	cwd?: string;
}

export interface CanopyHost {
	prepareChild(request: SpawnRequest): PreparedChild;
	runChild(child: ChildRecord, message: string): Promise<Omit<AgentCompletion, "id">>;
	stopChild(child: ChildRecord): Promise<void>;
	shutdownChild(child: ChildRecord): Promise<void>;
	persist(child: ChildRecord): void;
	deliver(completion: AgentCompletion): void;
}

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

interface ChildNode extends ChildRecord {
	generation: number;
	settled: Deferred;
	claims: Set<symbol>;
	stopRequested: boolean;
	queuedMessages: string[];
	turnResults: Array<Omit<AgentCompletion, "id">>;
}

function makeDeferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function now(): string {
	return new Date().toISOString();
}

function aggregateTurnResults(results: Array<Omit<AgentCompletion, "id">>): Omit<AgentCompletion, "id"> {
	const latest = results.at(-1) ?? { status: "failed" as const, error: "Child execution produced no turn result" };
	if (results.length <= 1) return latest;
	const result = results.map((turn, index) => {
		const labels = [`Child turn ${index + 1}`];
		if (index === results.length - 1) labels.push("latest");
		labels.push(turn.status);
		const body = turn.result ?? (turn.error ? `Error: ${turn.error}` : "(no text result)");
		return `[${labels.join(" — ")}]\n${body}`;
	}).join("\n\n");
	return { status: latest.status, result, error: latest.error };
}

function snapshot(node: ChildNode): ChildRecord {
	return {
		id: node.id,
		sessionFile: node.sessionFile,
		cwd: node.cwd,
		status: node.status,
		result: node.result,
		error: node.error,
		queuedMessages: [...node.queuedMessages],
		consumed: node.consumed,
		createdAt: node.createdAt,
		updatedAt: node.updatedAt,
	};
}

export class TreeScheduler {
	private runningByRoot = new Map<string, Set<string>>();

	hasCapacity(rootId: string, maximum: number): boolean {
		return (this.runningByRoot.get(rootId)?.size ?? 0) < maximum;
	}

	acquire(rootId: string, id: string, maximum: number): boolean {
		const running = this.runningByRoot.get(rootId) ?? new Set<string>();
		if (running.size >= maximum) return false;
		running.add(id);
		this.runningByRoot.set(rootId, running);
		return true;
	}

	release(rootId: string, id: string): void {
		const running = this.runningByRoot.get(rootId);
		if (!running) return;
		running.delete(id);
		if (running.size === 0) this.runningByRoot.delete(rootId);
	}
}

export class Canopy {
	private children = new Map<string, ChildNode>();
	private host: CanopyHost;
	private scheduler: TreeScheduler;
	private rootId: string;
	private maxConcurrent: number;

	constructor(host: CanopyHost, scheduler: TreeScheduler, options: { rootId: string; maxConcurrent: number }) {
		this.host = host;
		this.scheduler = scheduler;
		this.rootId = options.rootId;
		this.maxConcurrent = options.maxConcurrent;
	}

	spawn(request: SpawnRequest): { id: string } {
		if (!request.message.trim()) throw new Error("spawn requires a non-empty message");
		if (!this.scheduler.hasCapacity(this.rootId, this.maxConcurrent)) {
			throw new Error(`Agent concurrency limit reached (${this.maxConcurrent})`);
		}
		const prepared = this.host.prepareChild(request);
		if (!this.scheduler.acquire(this.rootId, prepared.id, this.maxConcurrent)) {
			throw new Error(`Agent concurrency limit reached (${this.maxConcurrent})`);
		}
		const timestamp = now();
		const node: ChildNode = {
			...prepared,
			status: "running",
			consumed: false,
			createdAt: timestamp,
			updatedAt: timestamp,
			generation: 0,
			settled: makeDeferred(),
			claims: new Set(),
			stopRequested: false,
			queuedMessages: [],
			turnResults: [],
		};
		this.children.set(node.id, node);
		this.persist(node);
		this.startTurn(node, request.message);
		return { id: node.id };
	}

	send(id: string, message: string): void {
		const node = this.directChild(id);
		if (!message.trim()) throw new Error("send requires a non-empty message");
		if (node.status === "running") {
			if (node.stopRequested) throw new Error(`Direct child ${id} is stopping`);
			node.queuedMessages.push(message);
			node.updatedAt = now();
			this.persist(node);
			return;
		}
		if (!this.scheduler.acquire(this.rootId, node.id, this.maxConcurrent)) {
			throw new Error(`Agent concurrency limit reached (${this.maxConcurrent})`);
		}
		node.queuedMessages.push(message);
		const firstMessage = node.queuedMessages.shift()!;
		node.status = "running";
		node.result = undefined;
		node.error = undefined;
		node.consumed = false;
		node.stopRequested = false;
		node.updatedAt = now();
		node.settled = makeDeferred();
		node.turnResults = [];
		this.persist(node);
		this.startTurn(node, firstMessage);
	}

	async wait(options: { ids?: string[]; timeoutSeconds: number; signal?: AbortSignal }): Promise<{ results: AgentCompletion[]; pending: string[]; timed_out: boolean }> {
		const ids = options.ids === undefined
			? [...this.children.values()].filter((node) => node.status === "running").map((node) => node.id)
			: [...new Set(options.ids)];
		const nodes = ids.map((id) => this.directChild(id));
		const claim = Symbol("wait");
		for (const node of nodes) {
			if (node.status === "running" && !node.consumed) node.claims.add(claim);
		}

		let timedOut = false;
		const running = nodes.filter((node) => node.status === "running");
		if (running.length > 0) {
			const timeoutMs = Math.max(0, options.timeoutSeconds * 1000);
			let timer: ReturnType<typeof setTimeout> | undefined;
			let abortHandler: (() => void) | undefined;
			try {
				const waits: Promise<unknown>[] = [
					Promise.all(running.map((node) => node.settled.promise)),
					new Promise<void>((resolve) => {
						timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
					}),
				];
				if (options.signal) {
					waits.push(new Promise<void>((_resolve, reject) => {
						abortHandler = () => reject(new DOMException("Agent wait aborted", "AbortError"));
						if (options.signal!.aborted) abortHandler();
						else options.signal!.addEventListener("abort", abortHandler, { once: true });
					}));
				}
				await Promise.race(waits);
			} catch (error) {
				for (const node of nodes) {
					node.claims.delete(claim);
					if (node.status !== "running" && !node.consumed) this.queueAutomaticDelivery(node);
				}
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
				if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
			}
		}

		const results: AgentCompletion[] = [];
		const pending: string[] = [];
		for (const node of nodes) {
			if (node.status === "running") {
				pending.push(node.id);
			} else {
				results.push(this.consume(node));
			}
			node.claims.delete(claim);
			if (node.status !== "running" && !node.consumed) this.queueAutomaticDelivery(node);
		}
		return { results, pending, timed_out: timedOut && pending.length > 0 };
	}

	async stop(id: string): Promise<{ id: string; status: AgentStatus }> {
		const node = this.directChild(id);
		if (node.status !== "running") {
			node.queuedMessages = [];
			node.turnResults = [];
			this.markConsumed(node);
			return { id: node.id, status: node.status };
		}

		const claim = Symbol("stop");
		node.claims.add(claim);
		node.stopRequested = true;
		const queuedMessages = node.queuedMessages.splice(0);
		const generation = node.generation;
		try {
			await this.host.stopChild(snapshot(node));
			if (node.status === "running" && node.generation === generation) {
				this.finishTurn(node, generation, { status: "stopped" });
			}
			this.markConsumed(node);
			return { id: node.id, status: "stopped" };
		} catch (error) {
			node.stopRequested = false;
			if (node.status === "running") node.queuedMessages.unshift(...queuedMessages);
			throw error;
		} finally {
			node.claims.delete(claim);
			if (node.status !== "running" && !node.consumed) this.queueAutomaticDelivery(node);
		}
	}

	get(id: string): ChildRecord {
		return snapshot(this.directChild(id));
	}

	list(): ChildRecord[] {
		return [...this.children.values()].map(snapshot);
	}

	hasRunning(): boolean {
		return [...this.children.values()].some((node) => node.status === "running");
	}

	async waitForIdle(): Promise<void> {
		while (true) {
			const running = [...this.children.values()].filter((node) => node.status === "running");
			if (running.length === 0) return;
			await Promise.all(running.map((node) => node.settled.promise));
		}
	}

	restore(records: ChildRecord[]): void {
		for (const record of records) {
			const queuedMessages = [...(record.queuedMessages ?? [])];
			const interrupted = record.status === "running";
			const node: ChildNode = {
				...record,
				status: interrupted ? "stopped" : record.status,
				result: interrupted && queuedMessages.length > 0
					? `Process recovery stopped this child with ${queuedMessages.length} queued follow-up${queuedMessages.length === 1 ? "" : "s"} preserved. Use send to resume or stop to discard them.`
					: record.consumed ? undefined : record.result,
				error: interrupted || record.consumed ? undefined : record.error,
				updatedAt: interrupted ? now() : record.updatedAt,
				generation: 0,
				settled: makeDeferred(),
				claims: new Set(),
				stopRequested: false,
				queuedMessages,
				turnResults: [],
			};
			node.settled.resolve();
			this.children.set(node.id, node);
			if (record.status === "running") this.persist(node);
		}
	}

	deliverPending(): void {
		for (const node of this.children.values()) {
			if (node.status !== "running" && !node.consumed) this.queueAutomaticDelivery(node);
		}
	}

	async stopAll(): Promise<void> {
		const errors: unknown[] = [];
		for (const node of this.children.values()) {
			if (node.status !== "running") continue;
			try {
				await this.stop(node.id);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "Failed to stop all child agents");
	}

	async shutdown(): Promise<void> {
		const errors: unknown[] = [];
		try {
			await this.stopAll();
		} catch (error) {
			errors.push(error);
		}
		for (const node of this.children.values()) {
			try {
				await this.host.shutdownChild(snapshot(node));
			} catch (error) {
				errors.push(error);
			} finally {
				if (node.status === "running") this.forceStopForShutdown(node);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "Failed to shut down all child agents");
	}

	private directChild(id: string): ChildNode {
		const node = this.children.get(id);
		if (!node) throw new Error(`Agent ${id} is not a direct child of this session`);
		return node;
	}

	private persist(node: ChildNode): void {
		this.host.persist(snapshot(node));
	}

	private startTurn(node: ChildNode, message: string): void {
		const generation = ++node.generation;
		void this.runTurnSequence(node, generation, message).then(
			(completion) => this.finishTurn(node, generation, completion),
			(error) => this.finishTurn(node, generation, {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}

	private async runTurnSequence(node: ChildNode, generation: number, initialMessage: string): Promise<Omit<AgentCompletion, "id">> {
		let message = initialMessage;
		while (true) {
			if (node.generation !== generation || node.status !== "running") return { status: "stopped" };
			let completion: Omit<AgentCompletion, "id">;
			try {
				completion = await this.host.runChild(snapshot(node), message);
			} catch (error) {
				completion = { status: "failed", error: error instanceof Error ? error.message : String(error) };
			}
			if (node.generation !== generation || node.status !== "running") return { status: "stopped" };
			node.turnResults.push(completion);
			if (node.stopRequested || completion.status === "stopped") {
				node.queuedMessages = [];
				return aggregateTurnResults(node.turnResults);
			}
			const next = node.queuedMessages.shift();
			if (next === undefined) return aggregateTurnResults(node.turnResults);
			this.persist(node);
			message = next;
		}
	}

	private finishTurn(node: ChildNode, generation: number, completion: Omit<AgentCompletion, "id">): void {
		if (node.generation !== generation || node.status !== "running") return;
		this.scheduler.release(this.rootId, node.id);
		node.status = node.stopRequested ? "stopped" : completion.status;
		node.result = node.stopRequested ? undefined : completion.result;
		node.error = node.status === "failed" ? completion.error : undefined;
		node.updatedAt = now();
		node.stopRequested = false;
		node.queuedMessages = [];
		node.turnResults = [];
		this.persist(node);
		node.settled.resolve();
		this.queueAutomaticDelivery(node);
	}

	private consume(node: ChildNode): AgentCompletion {
		const completion: AgentCompletion = { id: node.id, status: node.status as AgentStatus };
		if (!node.consumed) {
			if (node.result !== undefined) completion.result = node.result;
			if (node.error !== undefined) completion.error = node.error;
			this.markConsumed(node);
		}
		return completion;
	}

	private markConsumed(node: ChildNode): void {
		node.consumed = true;
		node.result = undefined;
		node.error = undefined;
		this.persist(node);
	}

	private forceStopForShutdown(node: ChildNode): void {
		this.scheduler.release(this.rootId, node.id);
		node.status = "stopped";
		node.result = undefined;
		node.error = undefined;
		node.consumed = true;
		node.stopRequested = false;
		node.queuedMessages = [];
		node.turnResults = [];
		node.updatedAt = now();
		this.persist(node);
		node.settled.resolve();
	}

	private queueAutomaticDelivery(node: ChildNode): void {
		queueMicrotask(() => {
			if (node.status === "running" || node.consumed || node.claims.size > 0) return;
			const completion = this.consume(node);
			this.host.deliver(completion);
		});
	}
}
