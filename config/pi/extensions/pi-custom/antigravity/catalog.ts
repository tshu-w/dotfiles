import { getModels } from "@earendil-works/pi-ai/compat";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createAcpConnection } from "./transport.js";

type CatalogModel = Extract<ProviderModelConfig, { type?: "chat" }>;

export function catalogModel(id: string): CatalogModel {
  const model = getModels("google").find((model) => model.id === id)!;
  const reasoning = ["gemini-4-neon", "gemini-4-hydrogen", "gemini-4-carbon"].includes(id);
  return {
    id, name: model.name, reasoning, input: ["text", "image"],
    ...(reasoning ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    compat: { supportsMidConvoSystemMessages: false },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
  };
}

export function isGeminiModelId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith("gemini-") && getModels("google").some((model) => model.id === id);
}

export async function discoverModels(cwd: string, signal: AbortSignal): Promise<CatalogModel[]> {
  const connection = await createAcpConnection(cwd, {
    update() {},
    tool: async () => { throw new Error("Model discovery cannot execute tools"); },
  }, [], undefined, signal);
  const abort = () => connection.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    // The catalog is session-scoped. Do not authenticate or send a prompt.
    const session = await connection.request("session/new", { cwd, mcpServers: [] });
    const selector = session.configOptions?.find((option: any) => option.type === "select" && (option.category === "model" || option.id === "model"));
    const choices = (selector?.options ?? []).flatMap((entry: any) => Array.isArray(entry.options) ? entry.options : [entry]);
    const ids = choices.length ? choices.map((entry: any) => entry.value)
      : (session.models?.availableModels ?? []).map((entry: any) => entry.modelId);
    const models = new Map<string, CatalogModel>();
    for (const id of ids) {
      if (!isGeminiModelId(id) || models.has(id)) continue;
      models.set(id, catalogModel(id));
    }
    if (!models.size) throw new Error("Antigravity did not advertise any models");
    return [...models.values()];
  } finally {
    signal.removeEventListener("abort", abort);
    connection.close();
  }
}
