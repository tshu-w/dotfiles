import { complete, getModel, StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getEnabledModels } from "./utils.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Filter `available` models to those matching the enabledModels patterns. */
function filterScoped(available: any[], patterns: string[]): any[] {
	if (patterns.length === 0) return available;
	return available.filter((m: any) => {
		const key = `${m.provider}/${m.id}`;
		return patterns.some(p => key === p || m.id === p);
	});
}

/**
 * Resolve a model by id (and optional provider), preferring scoped models.
 *
 * If `provider` is given, looks up directly via the registry.
 * If not, prefers a scoped match (matching settings.json `enabledModels`),
 * then falls back to any available model with the same id.
 *
 * `includeUnregistered` (only for consult) lets callers fall back to
 * `getModel(provider, modelId)` so consult can hit a model the registry
 * doesn't yet know but that does have an API key configured.
 */
async function resolveModel(
	ctx: any,
	provider: string | undefined,
	modelId: string,
	opts?: { includeUnregistered?: boolean },
): Promise<any | null> {
	if (provider) {
		const found = ctx.modelRegistry.find(provider, modelId);
		if (found) return found;
		if (opts?.includeUnregistered) return getModel(provider, modelId);
		return null;
	}
	const available = await ctx.modelRegistry.getAvailable();
	const scoped = filterScoped(available, getEnabledModels(ctx.cwd));
	return scoped.find((m: any) => m.id === modelId) ?? available.find((m: any) => m.id === modelId) ?? null;
}

export function registerModelsRouter(pi: ExtensionAPI) {
	pi.registerTool({
		name: "models",
		label: "Models",
		description: [
			"Model listing, switching, and consultation.",
			"list: show available models (scoped or all).",
			"switch: change active model for subsequent turns; preferably include `message` to continue work immediately.",
			"consult: one-shot call to another model (no tool access, result inline).",
		].join(" "),
		promptSnippet: "Model control: list, switch, consult",
		promptGuidelines: [
			"Use models(action='list') to discover available models before switching.",
			"Prefer models(action='switch', ..., message=...) when handing work to another model.",
			"Use models(action='consult') for second opinions or cross-model review.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "switch", "consult"] as const, {
				description: "Action to perform",
			}),
			// list params
			scope: Type.Optional(StringEnum(["scoped", "all"] as const, { description: '"scoped" (default) or "all". For list.' })),
			filter: Type.Optional(Type.String({ description: "Filter by provider or model name substring. For list." })),
			// switch / consult params
			provider: Type.Optional(Type.String({ description: 'Model provider. Optional: auto-resolved from scoped models if omitted. For switch/consult.' })),
			modelId: Type.Optional(Type.String({ description: 'Model ID, e.g. "claude-sonnet-4-5". For switch/consult.' })),
			thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level. For switch or consult." })),
			message: Type.Optional(Type.String({ description: "Optional continuation message after switching. For switch." })),
			deliverAs: Type.Optional(StringEnum(["steer", "followUp"] as const, { description: '"followUp" (default) or "steer". For switch (with message).' })),
			// consult params
			prompt: Type.Optional(Type.String({ description: "Prompt to send. For consult." })),
			systemPrompt: Type.Optional(Type.String({ description: "Optional system prompt. For consult." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			switch (params.action) {
				// ── list ─────────────────────────────────────────────
				case "list": {
					const scope = params.scope ?? "scoped";
					const available = await ctx.modelRegistry.getAvailable();
					const enabledPatterns = getEnabledModels(ctx.cwd);

					let candidates = available;
					if (scope === "scoped") {
						candidates = filterScoped(available, enabledPatterns);
					}

					const filter = params.filter?.toLowerCase();
					const filtered = filter
						? candidates.filter(m =>
							`${m.provider}/${m.id}`.toLowerCase().includes(filter)
							|| (m.name ?? "").toLowerCase().includes(filter)
						)
						: candidates;

					const header = scope === "scoped" && enabledPatterns.length > 0
						? `scoped models (${enabledPatterns.length} configured)`
						: scope === "scoped"
							? "no scoped models configured, showing all:"
							: "all available models:";

					if (filtered.length === 0) {
						return {
							content: [{ type: "text", text: `${header}\nNo models found${filter ? ` matching "${params.filter}"` : ""}. Check API keys.` }],
							details: { scope, models: [] },
						};
					}

					const lines = filtered.map(m =>
						`- \`${m.provider}/${m.id}\`  ctx:${m.contextWindow}  reasoning:${m.reasoning ?? false}`
					);

					return {
						content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
						details: { scope, models: filtered.map(m => ({ provider: m.provider, id: m.id })) },
					};
				}

				// ── switch ──────────────────────────────────────────
				case "switch": {
					if (!params.modelId) {
						return { content: [{ type: "text", text: "`modelId` is required for switch." }], details: {} };
					}

					const model = await resolveModel(ctx, params.provider, params.modelId);
					if (!model) {
						return {
							content: [{ type: "text", text: `Model not found: ${params.provider ?? "(auto)"}/${params.modelId}. Use models(action='list') to find valid models.` }],
							details: {},
						};
					}

					const success = await pi.setModel(model);
					if (!success) {
						return { content: [{ type: "text", text: `No API key for ${model.provider}/${model.id}.` }], details: {} };
					}

					if (params.thinkingLevel) pi.setThinkingLevel(params.thinkingLevel);

					const level = pi.getThinkingLevel();

					// Send continuation message if provided
					if (params.message) {
						await pi.sendUserMessage(params.message, { deliverAs: params.deliverAs ?? "followUp" });
						return {
							content: [{ type: "text", text: `switched to ${model.provider}/${model.id} (thinking: ${level}). continuation message sent.` }],
							details: { provider: model.provider, modelId: model.id, thinkingLevel: level, messageSent: true },
						};
					}

					return {
						content: [{ type: "text", text: `switched to ${model.provider}/${model.id} (thinking: ${level}). no continuation message sent.` }],
						details: { provider: model.provider, modelId: model.id, thinkingLevel: level, messageSent: false },
					};
				}

				// ── consult ─────────────────────────────────────────
				case "consult": {
					if (!params.modelId || !params.prompt) {
						return { content: [{ type: "text", text: "`modelId` and `prompt` are required for consult." }], details: {} };
					}

					const model = await resolveModel(ctx, params.provider, params.modelId, { includeUnregistered: true });
					if (!model) {
						return { content: [{ type: "text", text: `Model not found: ${params.provider ?? "(auto)"}/${params.modelId}` }], details: {} };
					}

					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok || !auth.apiKey) {
						return { content: [{ type: "text", text: `No API key for ${model.provider}/${model.id}` }], details: {} };
					}

					const thinkingLevel = params.thinkingLevel;
					const useReasoning = !!(model.reasoning && thinkingLevel && thinkingLevel !== "off");
					const completeOpts: any = { apiKey: auth.apiKey, headers: auth.headers, signal };
					if (useReasoning) completeOpts.reasoning = thinkingLevel;

					onUpdate?.({ content: [{ type: "text", text: `Consulting ${model.provider}/${model.id}${useReasoning ? ` (thinking: ${thinkingLevel})` : ""}...` }], details: {} });

					const response = await complete(
						model,
						{
							systemPrompt: params.systemPrompt ?? "You are a helpful assistant. Be concise and precise.",
							messages: [{ role: "user", content: [{ type: "text", text: params.prompt }], timestamp: Date.now() }],
						},
						completeOpts,
					);

					if (response.stopReason === "aborted") {
						return { content: [{ type: "text", text: "Consultation aborted." }], details: {} };
					}

					const text = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map(c => c.text).join("\n");

					const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
					const usage = response.usage;
					const stats = [
						usage ? `↑${usage.input} ↓${usage.output}` : "",
						usage?.cost?.total ? `$${usage.cost.total.toFixed(4)}` : "",
					].filter(Boolean).join(" ");
					const truncNote = truncation.truncated ? "\n\n*(output truncated)*" : "";

					return {
						content: [{ type: "text", text: `response from ${model.provider}/${model.id}${useReasoning ? ` (thinking: ${thinkingLevel})` : ""} ${stats}\n\n${truncation.content}${truncNote}` }],
						details: { provider: model.provider, modelId: model.id, thinkingLevel: useReasoning ? thinkingLevel : undefined, usage, truncated: truncation.truncated },
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	});
}
