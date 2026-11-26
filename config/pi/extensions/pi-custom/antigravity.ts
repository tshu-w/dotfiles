import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAntigravityBridge, PROVIDER_ID, type BridgeState } from "./antigravity/bridge.js";
import { catalogModel, isGeminiModelId, discoverModels } from "./antigravity/catalog.js";
import { isAuthenticationRequired } from "./antigravity/transport.js";

const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi", "antigravity-bridge");
const statePath = (id: string) => join(STATE_DIR, `${createHash("sha256").update(id).digest("hex")}.json`);

function loadState(ctx: ExtensionContext): BridgeState | undefined {
  try {
    const { leafId, ...state } = JSON.parse(readFileSync(statePath(ctx.sessionManager.getSessionId()), "utf8"));
    return ctx.sessionManager.getBranch().some((entry) => entry.id === leafId) ? state : undefined;
  } catch {
    return undefined;
  }
}

// Sessions in one process share the provider registry. Route to the requesting Session.
const bridges: Map<string, ReturnType<typeof createAntigravityBridge>> =
  (globalThis as Record<symbol, any>)[Symbol.for("pi-custom:antigravity-bridges")] ??= new Map();

export function registerAntigravity(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  const clear = () => { if (sessionId) rmSync(statePath(sessionId), { force: true }); };
  const bridge = createAntigravityBridge({
    cwd: () => context!.cwd,
    piSessionId: () => sessionId,
    onImport(losses) {
      if (!context?.hasUI) return;
      const fields = [
        [losses.toolResultsTruncated, "tool result", "shortened"],
        [losses.userTruncated, "user message", "shortened"],
        [losses.earlierMessagesOmitted, "earlier message", "omitted"],
        [losses.intermediateMessagesOmitted, "intermediate message", "omitted"],
        [losses.toolImagesOmitted, "image", "omitted"],
      ] as const;
      const items = fields.filter(([count]) => count > 0)
        .map(([count, noun, verb]) => `${count} ${noun}${count === 1 ? "" : "s"} ${verb}`);
      if (items.length) context.ui.notify(`Antigravity imported this history with ${items.join(", ")}.`, "warning");
    },
    claim(state) {
      const path = statePath(sessionId!), claimed = `${path}.${randomUUID()}.claimed`;
      try {
        renameSync(path, claimed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      try {
        const saved = JSON.parse(readFileSync(claimed, "utf8"));
        return saved.sessionId === state.sessionId && saved.configuration === state.configuration
          && saved.appDataDir === state.appDataDir && saved.imported === state.imported && saved.historyLength === state.historyLength && saved.historyKey === state.historyKey;
      } finally {
        rmSync(claimed, { force: true });
      }
    },
    save(state) {
      const leafId = context!.sessionManager.getLeafId();
      if (!leafId || !context!.sessionManager.getSessionFile()) return;
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      const path = statePath(sessionId!), temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ ...state, leafId }), { mode: 0o600 });
      renameSync(temp, path);
      return true;
    },
  });
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
        if (!signal.aborted) context?.ui.notify(`Could not refresh Antigravity models (${isAuthenticationRequired(error)
          ? "agy is not signed in" : (error as Error).message}).`, "warning");
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
    bridge.restore(loadState(ctx));
  });
  const navigate = () => { bridge.reset(); clear(); };
  pi.on("session_tree", navigate);
  pi.on("session_compact", navigate);
  pi.on("agent_settled", () => bridge.settle());
  pi.on("session_shutdown", release);
}

export default registerAntigravity;
