import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getModels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSessionPath } from "cc-session-io";
import { createClaudeBridge, type BridgeState } from "./claude/bridge.js";
import { PROVIDER_ID } from "./claude/convert.js";

const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi", "claude-bridge");

// One file per Pi session, overwritten after each turn, so resume state never grows the session file.
function statePath(piSessionId: string): string {
  return join(STATE_DIR, `${createHash("sha256").update(piSessionId).digest("hex")}.json`);
}

type StoredState = BridgeState & { piSessionFile?: string };

function saveState(state: BridgeState, piSessionFile: string | undefined) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const path = statePath(state.piSessionId), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...state, piSessionFile: piSessionFile ? resolve(piSessionFile) : undefined }), { mode: 0o600 });
  renameSync(temp, path);
}

function loadState(piSessionId: string): BridgeState | undefined {
  try {
    const { piSessionFile: _file, ...state } = JSON.parse(readFileSync(statePath(piSessionId), "utf8")) as StoredState;
    return state;
  } catch {
    return undefined;
  }
}

// Remove state only when its recorded Pi session file is gone; legacy states without a path stay.
// A state written in the last minute may belong to a session whose file Pi has not flushed yet.
// Keep Claude Code sessions another state still uses; older ones are left to Claude Code's expiry.
export function removeOrphanedStates(stateDir = STATE_DIR, now = Date.now()) {
  const states = readdirSync(stateDir).filter((name) => name.endsWith(".json")).flatMap((name) => {
    const path = join(stateDir, name);
    try {
      return [{ path, state: JSON.parse(readFileSync(path, "utf8")) as StoredState, mtime: statSync(path).mtimeMs }];
    } catch {
      return [];
    }
  });
  const orphaned = states.filter(({ state, mtime }) => {
    if (!state.piSessionFile || now - mtime <= 60_000) return false;
    try {
      statSync(state.piSessionFile);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  });
  // A forked Session's state may point into its parent's Claude Code session.
  const sessions = (state: BridgeState) => [state, ...state.points ?? []].flatMap((point) => point.sessionId ? [point] : []);
  const kept = new Set(states.filter((entry) => !orphaned.includes(entry)).flatMap(({ state }) => sessions(state).map((point) => point.sessionId)));
  for (const { path, state } of orphaned) {
    rmSync(path, { force: true });
    for (const point of sessions(state)) {
      if (!kept.has(point.sessionId!)) rmSync(getSessionPath(point.sessionId!, point.cwd!), { force: true });
    }
  }
}

function parentSessionId(sessionFile: string): string | undefined {
  try {
    const fd = openSync(sessionFile, "r"), buffer = Buffer.alloc(4096);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    closeSync(fd);
    const header = JSON.parse(buffer.subarray(0, length).toString("utf8").split("\n", 1)[0]!);
    return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } catch {
    return undefined;
  }
}

type Bridge = ReturnType<typeof createClaudeBridge>;

// Once per process: the first Session's start cleans up after sessions deleted since.
const ORPHANS_REMOVED = Symbol.for("pi-custom:claude-orphans-removed");

// Sessions in one process share the provider registry, where the last registration wins.
// Route each request to the bridge of the Session that sent it.
const bridges: Map<string, Bridge> = (globalThis as Record<symbol, any>)[Symbol.for("pi-custom:claude-bridges")] ??= new Map();

export function registerClaude(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let sessionId: string | undefined;
  const bridge = createClaudeBridge({
    cwd: () => context!.cwd,
    sessionId: () => context!.sessionManager.getSessionId(),
    save: (state) => saveState(state, context!.sessionManager.getSessionFile()),
    clear: () => rmSync(statePath(context!.sessionManager.getSessionId()), { force: true }),
    // Agents forked with the caller's context start from the caller's CC session.
    forkSources: () => [...bridges.values()].filter((other) => other !== bridge).flatMap((other) => other.points()),
  });

  pi.registerProvider(PROVIDER_ID, {
    name: "Claude Code",
    api: PROVIDER_ID,
    baseUrl: "https://api.anthropic.com",
    apiKey: "claude-code-managed",
    models: getModels("anthropic").filter((model) => !/-\d{8}$/.test(model.id)).map((model) => ({
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
  const restore = (event: { reason?: string; previousSessionFile?: string }, ctx: ExtensionContext) => {
    bridge.reset();
    release();
    context = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    bridges.set(sessionId, bridge);
    // A fork starts with its parent's history, so it may fork its parent's Claude Code session.
    const parent = event.reason === "fork" && event.previousSessionFile ? parentSessionId(event.previousSessionFile) : undefined;
    bridge.restore(loadState(sessionId), parent && parent !== sessionId ? loadState(parent)?.points ?? [] : []);
  };
  pi.on("session_start", (event, ctx) => {
    if (!(globalThis as Record<symbol, boolean>)[ORPHANS_REMOVED]) {
      (globalThis as Record<symbol, boolean>)[ORPHANS_REMOVED] = true;
      try { removeOrphanedStates(); } catch { /* cleanup is best effort */ }
    }
    restore(event, ctx);
  });
  pi.on("session_tree", () => bridge.navigate());
  pi.on("tool_execution_end", (event) => bridge.deliver(event.toolCallId, event.result?.content ?? [], event.isError));
  pi.on("session_shutdown", () => {
    bridge.reset();
    release();
  });
}

export default registerClaude;
