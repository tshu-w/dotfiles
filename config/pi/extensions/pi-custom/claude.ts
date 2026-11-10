import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createClaudeBridge, type ClaudeSession } from "./claude/bridge.js";
import { PROVIDER_ID } from "./claude/convert.js";

const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi", "claude-bridge");

// One file per Pi session, overwritten after each turn, so resume state never grows the session file.
function statePath(piSessionId: string): string {
  return join(STATE_DIR, `${createHash("sha256").update(piSessionId).digest("hex")}.json`);
}

function saveState(state: ClaudeSession) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const path = statePath(state.piSessionId), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, path);
}

function loadState(piSessionId: string): ClaudeSession | undefined {
  try {
    return JSON.parse(readFileSync(statePath(piSessionId), "utf8"));
  } catch {
    return undefined;
  }
}

// Temporary: Anthropic models added in Pi 1.5.1; drop this commit after upgrading Pi.
const PI_1_5_1_MODELS = [{
  id: "claude-fable-5-2", name: "Claude Fable 5.2", reasoning: true,
  thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
  compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true, supportsStrictTools: true,
    allowedFallbackModels: [{ provider: "anthropic", model: "claude-opus-5", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }] },
  input: ["text", "image"], cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }, contextWindow: 1000000, maxTokens: 128000,
}] as unknown as ReturnType<typeof getModels>;

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
    save: saveState,
    clear: () => rmSync(statePath(context!.sessionManager.getSessionId()), { force: true }),
    // Agents forked with the caller's context start from the caller's CC session.
    forkSources: () => [...bridges.values()].filter((other) => other !== bridge).flatMap((other) => other.points()),
  });

  pi.registerProvider(PROVIDER_ID, {
    name: "Claude Code",
    api: PROVIDER_ID,
    baseUrl: "https://api.anthropic.com",
    apiKey: "claude-code-managed",
    models: [...getModels("anthropic"), ...PI_1_5_1_MODELS.filter((extra) => !getModels("anthropic").some((model) => model.id === extra.id))]
      .filter((model) => !/-\d{8}$/.test(model.id)).map((model) => ({
      id: model.id,
      name: model.name.replace(/ \(latest\)$/, ""),
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: model.compat,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      // Claude Code writes 1-hour caches for subscription conversations.
      promptCache: { short: 3600, long: 3600 },
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
    bridge.restore(loadState(sessionId));
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", () => {
    bridge.reset();
    release();
  });
}

export default registerClaude;
