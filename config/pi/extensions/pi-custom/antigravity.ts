import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAntigravityBridge, PROVIDER_ID } from "./antigravity/bridge.js";
import { catalogModel, isGeminiModelId, discoverModels } from "./antigravity/catalog.js";

// Sessions in one process share the provider registry. Route to the requesting Session.
const bridges: Map<string, ReturnType<typeof createAntigravityBridge>> =
  (globalThis as Record<symbol, any>)[Symbol.for("pi-custom:antigravity-bridges")] ??= new Map();

export function registerAntigravity(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  const bridge = createAntigravityBridge({ cwd: () => context!.cwd });
  const streamSimple: ReturnType<typeof createAntigravityBridge>["streamSimple"] = (model, transcript, request) =>
    ((request?.sessionId && bridges.get(request.sessionId)) || bridge).streamSimple(model, transcript, request);
  pi.registerProvider(PROVIDER_ID, {
    name: "Antigravity",
    api: PROVIDER_ID,
    baseUrl: "https://cloudcode-pa.googleapis.com",
    // Authentication belongs to agy; Pi never reads or stores its credentials.
    apiKey: "antigravity-cli-managed",
    models: [],
    async refreshModels({ allowNetwork, stored, publish, signal }) {
      if (!allowNetwork) {
        const cached = stored?.models.filter((model) => model.provider === PROVIDER_ID && isGeminiModelId(model.id)) ?? [];
        return cached.map((model) => catalogModel(model.id));
      }
      let models;
      try {
        models = await discoverModels(context?.cwd ?? process.cwd(), signal);
      } catch (error) {
        if (!signal.aborted) context?.ui.notify(`Antigravity model discovery: ${(error as Error).message}`, "error");
        throw error;
      }
      await publish({ persist: {
        models: models.map((model) => ({ ...model, api: PROVIDER_ID, provider: PROVIDER_ID, baseUrl: "https://cloudcode-pa.googleapis.com" })),
        checkedAt: Date.now(),
      } });
      return models;
    },
    streamSimple,
  });
  const release = () => {
    bridge.reset();
    if (sessionId && bridges.get(sessionId) === bridge) bridges.delete(sessionId);
  };
  pi.on("session_start", (_event, ctx) => {
    release();
    context = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    bridges.set(sessionId, bridge);
  });
  pi.on("session_tree", () => bridge.reset());
  pi.on("agent_settled", () => bridge.settle());
  pi.on("session_shutdown", release);
}

export default registerAntigravity;
