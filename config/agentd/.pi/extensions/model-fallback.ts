import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

type FallbackTarget = {
	provider: string;
	model: string;
};

type FallbackConfig = {
	enabled: boolean;
	fallbacks: FallbackTarget[];
	maxAttemptsPerPrompt?: number;
	errorPattern?: string;
};

type FallbackState = {
	promptKey: string;
	attempted: Set<string>;
	initialModel?: FallbackTarget;
};

const RETRYABLE_ERROR_RE =
	/overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server error|internal error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay/i;

function modelKey(target: FallbackTarget): string {
	return `${target.provider}/${target.model}`;
}

function normalizeTarget(value: unknown): FallbackTarget | null {
	if (!value || typeof value !== "object") return null;
	const provider = String((value as { provider?: unknown }).provider || "").trim();
	const model = String((value as { model?: unknown }).model || "").trim();
	if (!provider || !model) return null;
	return { provider, model };
}

function normalizeConfig(value: unknown): FallbackConfig | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as {
		enabled?: unknown;
		fallbacks?: unknown;
		maxAttemptsPerPrompt?: unknown;
		errorPattern?: unknown;
	};

	const enabled = raw.enabled !== false;
	const fallbackList = Array.isArray(raw.fallbacks) ? raw.fallbacks : [];
	const deduped = new Map<string, FallbackTarget>();
	for (const item of fallbackList) {
		const target = normalizeTarget(item);
		if (!target) continue;
		deduped.set(modelKey(target), target);
	}

	let maxAttemptsPerPrompt: number | undefined;
	if (raw.maxAttemptsPerPrompt !== undefined) {
		const n = Number.parseInt(String(raw.maxAttemptsPerPrompt), 10);
		if (Number.isFinite(n) && n > 0) {
			maxAttemptsPerPrompt = n;
		}
	}

	const errorPattern =
		typeof raw.errorPattern === "string" && raw.errorPattern.trim() ? raw.errorPattern.trim() : undefined;

	return {
		enabled,
		fallbacks: Array.from(deduped.values()),
		maxAttemptsPerPrompt,
		errorPattern,
	};
}

function resolveConfigCandidates(cwd: string): string[] {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
	const globalPath = path.join(xdgConfigHome, "pi", "fallbacks.json");
	const projectPath = path.join(cwd, ".pi", "fallbacks.json");
	return [projectPath, globalPath];
}

function loadFallbackConfig(cwd: string): FallbackConfig | null {
	for (const filePath of resolveConfigCandidates(cwd)) {
		if (!existsSync(filePath)) continue;
		try {
			const parsed = JSON.parse(readFileSync(filePath, "utf8"));
			const config = normalizeConfig(parsed);
			if (!config) {
				console.warn(`[model-fallback] invalid config in ${filePath}`);
				continue;
			}
			return config;
		} catch (err) {
			console.warn(`[model-fallback] failed to read ${filePath}:`, err);
		}
	}
	return null;
}

function buildPromptKey(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") {
		return createHash("sha256").update(content).digest("hex");
	}
	const normalized = content
		.map((part) => {
			if (part.type === "text") return `t:${part.text}`;
			return `i:${part.mimeType}:${part.data.length}`;
		})
		.join("\u241f");
	return createHash("sha256").update(normalized).digest("hex");
}

function isUserMessage(
	message: unknown,
): message is { role: "user"; content: string | (TextContent | ImageContent)[] } {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "user";
}

function isAssistantMessage(
	message: unknown,
): message is { role: "assistant"; stopReason?: string; errorMessage?: string } {
	return !!message && typeof message === "object" && (message as { role?: unknown }).role === "assistant";
}

function shouldFallback(errorMessage: string, config: FallbackConfig): boolean {
	if (!errorMessage.trim()) return true;
	if (!config.errorPattern) return RETRYABLE_ERROR_RE.test(errorMessage);
	try {
		return new RegExp(config.errorPattern, "i").test(errorMessage);
	} catch {
		return RETRYABLE_ERROR_RE.test(errorMessage);
	}
}

function buildChain(currentModel: { provider: string; id: string } | undefined, fallbacks: FallbackTarget[]): FallbackTarget[] {
	const deduped = new Map<string, FallbackTarget>();
	if (currentModel) {
		const current = { provider: currentModel.provider, model: currentModel.id };
		deduped.set(modelKey(current), current);
	}
	for (const fallback of fallbacks) {
		deduped.set(modelKey(fallback), fallback);
	}
	return Array.from(deduped.values());
}

export default function (pi: ExtensionAPI) {
	let state: FallbackState | null = null;

	const restoreInitialModel = async (ctx: ExtensionContext): Promise<void> => {
		if (!state?.initialModel) return;
		if (ctx.model && ctx.model.provider === state.initialModel.provider && ctx.model.id === state.initialModel.model) return;
		const model = ctx.modelRegistry.find(state.initialModel.provider, state.initialModel.model);
		if (!model) return;
		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) return;
		await pi.setModel(model);
	};

	pi.on("agent_end", async (event, ctx) => {
		const userMessage = event.messages.find(isUserMessage);
		const assistantMessage = [...event.messages].reverse().find(isAssistantMessage);
		if (!userMessage || !assistantMessage) {
			state = null;
			return;
		}

		const promptKey = buildPromptKey(userMessage.content);

		if (assistantMessage.stopReason !== "error") {
			if (state && state.promptKey === promptKey) {
				await restoreInitialModel(ctx);
			}
			state = null;
			return;
		}

		const config = loadFallbackConfig(ctx.cwd);
		if (!config || !config.enabled || config.fallbacks.length === 0) return;

		const errorMessage = String(assistantMessage.errorMessage || "");
		if (!shouldFallback(errorMessage, config)) return;

		if (!state || state.promptKey !== promptKey) {
			state = {
				promptKey,
				attempted: new Set(),
				initialModel: ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : undefined,
			};
		}

		if (ctx.model) {
			state.attempted.add(modelKey({ provider: ctx.model.provider, model: ctx.model.id }));
		}

		const chain = buildChain(ctx.model, config.fallbacks);
		const maxAttempts = config.maxAttemptsPerPrompt ?? chain.length;
		if (state.attempted.size >= maxAttempts) {
			if (ctx.hasUI) ctx.ui.notify("Fallback chain exhausted", "error");
			await restoreInitialModel(ctx);
			state = null;
			return;
		}

		for (const candidate of chain) {
			const key = modelKey(candidate);
			if (state.attempted.has(key)) continue;

			const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
			if (!model) continue;
			const apiKey = await ctx.modelRegistry.getApiKey(model);
			if (!apiKey) continue;

			const switched = await pi.setModel(model);
			if (!switched) continue;

			state.attempted.add(key);
			if (ctx.hasUI) {
				ctx.ui.notify(`Fallback to ${candidate.provider}/${candidate.model}`, "warning");
			}
			pi.sendUserMessage(userMessage.content);
			return;
		}

		if (ctx.hasUI) {
			ctx.ui.notify("No available fallback model", "error");
		}
		await restoreInitialModel(ctx);
		state = null;
	});
}
