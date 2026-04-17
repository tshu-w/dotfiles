import { complete, getModel, StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getEnabledModels } from "./utils.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

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
			provider: Type.Optional(Type.String({ description: 'Model provider, e.g. "anthropic", "openai". For switch/consult.' })),
			modelId: Type.Optional(Type.String({ description: 'Model ID, e.g. "claude-sonnet-4-5". For switch/consult.' })),
			thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level. For switch." })),
			message: Type.Optional(Type.String({ description: "Optional continuation message after switching. For switch." })),
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
					if (scope === "scoped" && enabledPatterns.length > 0) {
						candidates = available.filter(m => {
							const key = `${m.provider}/${m.id}`;
							return enabledPatterns.some(p => key === p || m.id === p);
						});
					}

					const filter = params.filter?.toLowerCase();
					const filtered = filter
						? candidates.filter(m =>
							`${m.provider}/${m.id}`.toLowerCase().includes(filter)
							|| m.name.toLowerCase().includes(filter)
						)
						: candidates;

					const header = scope === "scoped" && enabledPatterns.length > 0
						? `**Scoped models** (${enabledPatterns.length} configured):`
						: scope === "scoped"
							? "**No scoped models configured.** Showing all:"
							: "**All available models:**";

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
					if (!params.provider || !params.modelId) {
						return { content: [{ type: "text", text: "`provider` and `modelId` are required for switch." }], details: {} };
					}

					const model = ctx.modelRegistry.find(params.provider, params.modelId);
					if (!model) {
						return {
							content: [{ type: "text", text: `Model not found: ${params.provider}/${params.modelId}. Use models(action='list') to find valid models.` }],
							details: {},
						};
					}

					const success = await pi.setModel(model);
					if (!success) {
						return { content: [{ type: "text", text: `No API key for ${params.provider}/${params.modelId}.` }], details: {} };
					}

					if (params.thinkingLevel) pi.setThinkingLevel(params.thinkingLevel);

					const level = pi.getThinkingLevel();

					// Send continuation message if provided
					if (params.message) {
						if (ctx.isIdle()) {
							await pi.sendUserMessage(params.message);
						} else {
							await pi.sendUserMessage(params.message, { deliverAs: "steer" });
						}
						return {
							content: [{ type: "text", text: `Switched to **${params.provider}/${params.modelId}** (thinking: ${level}). Continuation message sent.` }],
							details: { provider: params.provider, modelId: params.modelId, thinkingLevel: level, messageSent: true },
						};
					}

					return {
						content: [{ type: "text", text: `Switched to **${params.provider}/${params.modelId}** (thinking: ${level}). No continuation message sent.` }],
						details: { provider: params.provider, modelId: params.modelId, thinkingLevel: level, messageSent: false },
					};
				}

				// ── consult ─────────────────────────────────────────
				case "consult": {
					if (!params.provider || !params.modelId || !params.prompt) {
						return { content: [{ type: "text", text: "`provider`, `modelId`, and `prompt` are required for consult." }], details: {} };
					}

					const model = ctx.modelRegistry.find(params.provider, params.modelId)
						?? getModel(params.provider, params.modelId);
					if (!model) {
						return { content: [{ type: "text", text: `Model not found: ${params.provider}/${params.modelId}` }], details: {} };
					}

					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok || !auth.apiKey) {
						return { content: [{ type: "text", text: `No API key for ${params.provider}/${params.modelId}` }], details: {} };
					}

					onUpdate?.({ content: [{ type: "text", text: `Consulting ${params.provider}/${params.modelId}...` }], details: {} });

					const response = await complete(
						model,
						{
							systemPrompt: params.systemPrompt ?? "You are a helpful assistant. Be concise and precise.",
							messages: [{ role: "user", content: [{ type: "text", text: params.prompt }], timestamp: Date.now() }],
						},
						{ apiKey: auth.apiKey, headers: auth.headers, signal },
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
						content: [{ type: "text", text: `**Response from ${params.provider}/${params.modelId}** ${stats}\n\n${truncation.content}${truncNote}` }],
						details: { provider: params.provider, modelId: params.modelId, usage, truncated: truncation.truncated },
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	});
}
