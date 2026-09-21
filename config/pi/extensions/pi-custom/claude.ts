import { getModels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createClaudeBridge, type ClaudeSession } from "./claude/bridge.js";
import { PROVIDER_ID } from "./claude/convert.js";

const SESSION_ENTRY = "pi-custom:claude-session";

export function registerClaude(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
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
    streamSimple: bridge.streamSimple,
  });

  const restore = (_event: unknown, ctx: ExtensionContext) => {
    bridge.reset();
    context = ctx;
    const entry = ctx.sessionManager.getBranch().findLast((entry) =>
      entry.type === "custom" && entry.customType === SESSION_ENTRY);
    if (entry?.type === "custom") bridge.restore(entry.data as ClaudeSession);
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", () => bridge.reset());
}

export default registerClaude;
