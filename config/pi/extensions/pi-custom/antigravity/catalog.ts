import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createAcpConnection } from "./transport.js";

type CatalogModel = Extract<ProviderModelConfig, { type?: "chat" }>;

export function catalogModel(id: string): CatalogModel {
  return {
    id, name: id, reasoning: false, input: ["text", "image"],
    compat: { supportsMidConvoSystemMessages: false },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // ACP model choices do not advertise context or output limits.
    contextWindow: 128000, maxTokens: 8192,
  };
}

export function isGeminiModelId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith("gemini-") && id.length > "gemini-".length;
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
