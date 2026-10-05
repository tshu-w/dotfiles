import { getModels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createClaudeBridge, type ClaudeSession } from "./claude/bridge.js";
import { PROVIDER_ID } from "./claude/convert.js";

const SESSION_ENTRY = "pi-custom:claude-session";

type Bridge = ReturnType<typeof createClaudeBridge>;

// Sessions in one process share the provider registry, where the last registration wins.
// Route each request to the bridge of the Session that sent it.
const bridges: Map<string, Bridge> = (globalThis as Record<symbol, any>)[Symbol.for("pi-custom:claude-bridges")] ??= new Map();

export function registerClaude(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  const bridge = createClaudeBridge({
    cwd: () => context!.cwd,
    sessionId: () => context!.sessionManager.getSessionId(),
    save: (state) => pi.appendEntry(SESSION_ENTRY, state),
  });

  pi.registerProvider(PROVIDER_ID, {
    name: "Claude Code",
    api: PROVIDER_ID,
    baseUrl: "https://api.anthropic.com",
    apiKey: "claude-code-managed",
    models: getModels("anthropic").filter((model) => !/-\d{8}$/.test(model.id)).map((model) => ({
      id: model.id,
      name: `${model.name} (Claude Code)`,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: model.compat,
      input: model.input,
      cost: model.cost,
      contextWindow: Math.min(model.contextWindow, 200_000),
      maxTokens: model.maxTokens,
    })),
    streamSimple: (model, transcript, request) =>
      ((request?.sessionId && bridges.get(request.sessionId)) || bridge).streamSimple(model, transcript, request),
  });

  const release = () => {
    if (sessionId && bridges.get(sessionId) === bridge) bridges.delete(sessionId);
  };
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    bridge.reset();
    release();
    context = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    bridges.set(sessionId, bridge);
    const entry = ctx.sessionManager.getBranch().findLast((entry) =>
      entry.type === "custom" && entry.customType === SESSION_ENTRY);
    if (entry?.type === "custom") bridge.restore(entry.data as ClaudeSession);
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", () => {
    bridge.reset();
    release();
  });
}

export default registerClaude;
