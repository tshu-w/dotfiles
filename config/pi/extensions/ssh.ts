/**
 * SSH Remote Execution Extension
 *
 * Features:
 * - `--ssh user@host[:/remote/path]` startup flag
 * - `/ssh` slash command to view/switch/disable SSH mode
 * - argument completions from ~/.ssh/config
 * - abort propagation and bounded SSH child termination
 * - subagent inheritance via environment variables
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const ENV_REMOTE = "PI_SSH_REMOTE";
const ENV_REMOTE_ROOT_CWD = "PI_SSH_REMOTE_CWD";
const ENV_LOCAL_ROOT_CWD = "PI_SSH_LOCAL_CWD";
const ENTRY_TYPE = "ssh-state";

const SSH_OFF_TEXT = "SSH: off";
const SSH_INACTIVE_ERROR = "SSH mode is not active";
const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const TERMINATION_GRACE_MS = 250;

type SshState = {
  remote: string;
  remoteRootCwd: string;
  localRootCwd: string;
};

type PersistedSshState =
  | {
      enabled: true;
      remote: string;
      remoteRootCwd: string;
      localRootCwd: string;
    }
  | {
      enabled: false;
    };

type StatusUI = Pick<ExtensionContext["ui"], "setStatus" | "theme">;
type NotifyUI = StatusUI & Pick<ExtensionContext["ui"], "notify">;

type StatusContext = Pick<ExtensionContext, "cwd" | "hasUI"> & {
  ui: StatusUI;
};

type MutationContext = StatusContext & {
  ui: NotifyUI;
};

type SessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

type SessionRestoreContext = StatusContext & {
  sessionManager: {
    getEntries: () => SessionEntry[];
  };
};

// Quote for the remote POSIX shell. JSON.stringify double-quoting is not
// enough: $, backticks, and ! still expand inside double quotes.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runSshProcess(
  remote: string,
  command: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    timeoutError?: Error;
    onStdout?: (data: Buffer) => void;
    onStderr?: (data: Buffer) => void;
  },
): Promise<number | null> {
  if (options.signal?.aborted) return Promise.reject(new Error("aborted"));

  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [remote, command], { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stopError: Error | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = (error: Error | undefined, code?: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(code ?? null);
    };
    const stop = (error: Error) => {
      if (settled || stopError) return;
      stopError = error;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        // Do not depend on a close event after escalation: cancellation and
        // timeout must settle within the grace period even for a stuck child.
        settle(stopError);
      }, TERMINATION_GRACE_MS);
    };
    const onAbort = () => stop(new Error("aborted"));

    child.stdout.on("data", options.onStdout ?? (() => {}));
    child.stderr.on("data", options.onStderr ?? (() => {}));
    child.on("error", (error) => settle(stopError ?? error));
    child.on("close", (code) => settle(stopError, code));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(
        () => stop(options.timeoutError ?? new Error(`SSH timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    }
  });
}

function sshExec(remote: string, command: string, signal?: AbortSignal, timeoutMs?: number): Promise<Buffer> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  return runSshProcess(remote, command, {
    signal,
    timeoutMs,
    onStdout: (data) => stdoutChunks.push(data),
    onStderr: (data) => stderrChunks.push(data),
  }).then((code) => {
    if (code !== 0) {
      throw new Error(`SSH failed (${code}): ${Buffer.concat(stderrChunks).toString()}`);
    }
    return Buffer.concat(stdoutChunks);
  });
}

function mapCwdToRemote(localCwd: string, state: SshState): string {
  const absolutePath = path.resolve(localCwd);
  const absoluteRoot = path.resolve(state.localRootCwd);
  const relative = path.relative(absoluteRoot, absolutePath);

  const isWithinRoot =
    relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));

  if (!isWithinRoot) return state.remoteRootCwd;

  const posixRelative = relative.split(path.sep).filter(Boolean).join("/");
  return posixRelative ? path.posix.join(state.remoteRootCwd, posixRelative) : state.remoteRootCwd;
}

function requireSshState(getSsh: () => SshState | null): SshState {
  const ssh = getSsh();
  if (!ssh) throw new Error(SSH_INACTIVE_ERROR);
  return ssh;
}

function createRemoteReadOps(getSsh: () => SshState | null, signal?: AbortSignal): ReadOperations {
  return {
    readFile: async (filePath) => {
      const ssh = requireSshState(getSsh);
      return sshExec(ssh.remote, `cat ${shellQuote(filePath)}`, signal);
    },
    access: async (filePath) => {
      const ssh = requireSshState(getSsh);
      await sshExec(ssh.remote, `test -r ${shellQuote(filePath)}`, signal);
    },
    detectImageMimeType: async (filePath) => {
      const ssh = getSsh();
      if (!ssh) return null;

      try {
        const result = await sshExec(ssh.remote, `file --mime-type -b ${shellQuote(filePath)}`, signal);
        const mimeType = result.toString().trim();
        return IMAGE_MIME_TYPES.includes(mimeType) ? mimeType : null;
      } catch (error) {
        if (signal?.aborted) throw error;
        return null;
      }
    },
  };
}

function createRemoteWriteOps(getSsh: () => SshState | null, signal?: AbortSignal): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      const ssh = requireSshState(getSsh);
      const base64 = Buffer.from(content).toString("base64");
      await sshExec(
        ssh.remote,
        `echo ${shellQuote(base64)} | base64 -d > ${shellQuote(filePath)}`,
        signal,
      );
    },
    mkdir: async (dirPath) => {
      const ssh = requireSshState(getSsh);
      await sshExec(ssh.remote, `mkdir -p ${shellQuote(dirPath)}`, signal);
    },
  };
}

function createRemoteEditOps(getSsh: () => SshState | null, signal?: AbortSignal): EditOperations {
  const readOps = createRemoteReadOps(getSsh, signal);
  const writeOps = createRemoteWriteOps(getSsh, signal);

  return {
    readFile: readOps.readFile,
    access: readOps.access,
    writeFile: writeOps.writeFile,
  };
}

function createRemoteBashOps(getSsh: () => SshState | null, { mapLocalCwd = false } = {}): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
      const ssh = requireSshState(getSsh);
      const remoteCwd = mapLocalCwd ? mapCwdToRemote(cwd, ssh) : cwd;
      const remoteCommand = `cd ${shellQuote(remoteCwd)} && ${command}`;
      const exitCode = await runSshProcess(ssh.remote, remoteCommand, {
        signal,
        timeoutMs: timeout ? timeout * 1000 : undefined,
        timeoutError: new Error(`timeout:${timeout}`),
        onStdout: onData,
        onStderr: onData,
      });
      return { exitCode };
    },
  };
}

function parseSshTarget(target: string): { remote: string; remotePath?: string } {
  const trimmed = target.trim();
  const slashIndex = trimmed.indexOf("/");
  const colonIndex = trimmed.indexOf(":");

  if (colonIndex !== -1 && (slashIndex === -1 || colonIndex < slashIndex)) {
    return {
      remote: trimmed.slice(0, colonIndex),
      remotePath: trimmed.slice(colonIndex + 1) || undefined,
    };
  }

  return { remote: trimmed };
}

async function resolveSshTarget(target: string, localRootCwd: string): Promise<SshState> {
  const { remote, remotePath } = parseSshTarget(target);
  // Bounded probe: an unreachable host must not hang /ssh or session_start.
  const remoteRootCwd = remotePath ? remotePath : (await sshExec(remote, "pwd", undefined, 15_000)).toString().trim();

  return {
    remote,
    remoteRootCwd,
    localRootCwd,
  };
}

function serializeState(state: SshState | null): PersistedSshState {
  if (!state) return { enabled: false };

  return {
    enabled: true,
    remote: state.remote,
    remoteRootCwd: state.remoteRootCwd,
    localRootCwd: state.localRootCwd,
  };
}

function deserializeState(data: unknown): SshState | null {
  if (!data || typeof data !== "object") return null;

  const record = data as Partial<PersistedSshState>;
  if (!record.enabled) return null;

  if (
    typeof record.remote !== "string" ||
    typeof record.remoteRootCwd !== "string" ||
    typeof record.localRootCwd !== "string"
  ) {
    return null;
  }

  return {
    remote: record.remote,
    remoteRootCwd: record.remoteRootCwd,
    localRootCwd: record.localRootCwd,
  };
}

function loadStateFromEnv(): SshState | null {
  const remote = process.env[ENV_REMOTE];
  const remoteRootCwd = process.env[ENV_REMOTE_ROOT_CWD];
  const localRootCwd = process.env[ENV_LOCAL_ROOT_CWD];

  if (!remote || !remoteRootCwd || !localRootCwd) return null;

  return {
    remote,
    remoteRootCwd,
    localRootCwd,
  };
}

function writeStateToEnv(state: SshState | null): void {
  if (!state) {
    delete process.env[ENV_REMOTE];
    delete process.env[ENV_REMOTE_ROOT_CWD];
    delete process.env[ENV_LOCAL_ROOT_CWD];
    return;
  }

  process.env[ENV_REMOTE] = state.remote;
  process.env[ENV_REMOTE_ROOT_CWD] = state.remoteRootCwd;
  process.env[ENV_LOCAL_ROOT_CWD] = state.localRootCwd;
}


function readSshHostCompletions(): string[] {
  const sshConfigPath = path.join(os.homedir(), ".ssh", "config");
  if (!fs.existsSync(sshConfigPath)) return [];

  try {
    const content = fs.readFileSync(sshConfigPath, "utf-8");
    const hosts = new Set<string>();

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = trimmed.match(/^Host\s+(.+)$/i);
      if (!match) continue;

      for (const part of match[1].split(/\s+/)) {
        if (!part || part.includes("*") || part.includes("?")) continue;
        hosts.add(part);
      }
    }

    return Array.from(hosts).sort();
  } catch {
    return [];
  }
}

function dedupeAutocompleteItems(items: AutocompleteItem[]): AutocompleteItem[] {
  return items.filter((item, index, list) => list.findIndex((candidate) => candidate.value === item.value) === index);
}

function getCommandCompletions(currentState: SshState | null, prefix: string): AutocompleteItem[] | null {
  const trimmed = prefix.trim();
  const items: AutocompleteItem[] = [{ value: "off", label: "off", description: "Disable SSH mode" }];

  if (currentState) {
    items.push({
      value: `${currentState.remote}:${currentState.remoteRootCwd}`,
      label: currentState.remote,
      description: `Current target (${currentState.remoteRootCwd})`,
    });
  }

  for (const host of readSshHostCompletions()) {
    items.push({ value: host, label: host, description: "Host from ~/.ssh/config" });
  }

  const filtered = dedupeAutocompleteItems(items).filter((item) => !trimmed || item.value.startsWith(trimmed));
  return filtered.length > 0 ? filtered : null;
}

function findPersistedState(ctx: SessionRestoreContext): { found: boolean; state: SshState | null } {
  const entry = ctx.sessionManager
    .getEntries()
    .filter((item) => item.type === "custom" && item.customType === ENTRY_TYPE)
    .pop();

  if (!entry) return { found: false, state: null };
  return { found: true, state: deserializeState(entry.data) };
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

  const initialCwd = process.cwd();
  const baseRead = createReadTool(initialCwd);
  const baseWrite = createWriteTool(initialCwd);
  const baseEdit = createEditTool(initialCwd);
  const baseBash = createBashTool(initialCwd);

  let activeSsh: SshState | null = null;

  const getSsh = () => activeSsh;

  const updateStatus = (ctx: StatusContext) => {
    if (!ctx.hasUI) return;

    if (!activeSsh) {
      ctx.ui.setStatus("ssh", undefined);
      return;
    }

    const remoteCwd = mapCwdToRemote(ctx.cwd, activeSsh);
    ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${activeSsh.remote}:${remoteCwd}`));
  };

  const applyState = async (
    nextState: SshState | null,
    ctx: MutationContext,
    options?: { persist?: boolean; notify?: boolean },
  ) => {
    activeSsh = nextState;
    writeStateToEnv(activeSsh);
    updateStatus(ctx);

    if (options?.persist) {
      pi.appendEntry(ENTRY_TYPE, serializeState(activeSsh));
    }

    if (options?.notify !== false && ctx.hasUI) {
      ctx.ui.notify(activeSsh ? `SSH mode: ${activeSsh.remote}:${mapCwdToRemote(ctx.cwd, activeSsh)} (disable: /ssh off)` : "SSH mode disabled", "info");
    }
  };

  const restoreState = (ctx: SessionRestoreContext) => {
    const persisted = findPersistedState(ctx);
    if (persisted.found) {
      activeSsh = persisted.state;
    } else {
      const envState = loadStateFromEnv();
      if (envState) {
        // Promote env-inherited SSH state to a persisted session entry, so a
        // later pi process (resume) can recover it even when PI_SSH_* env is
        // no longer set. Without this the tool silently falls back to local
        // execution across process restarts.
        activeSsh = envState;
        pi.appendEntry(ENTRY_TYPE, serializeState(envState));
      }
      // No persisted entry and no env: keep activeSsh as-is. restoreState()
      // also fires on session_tree; clobbering with null on a later refresh
      // would silently drop SSH mode established earlier in this process.
    }
    writeStateToEnv(activeSsh);
    updateStatus(ctx);
  };

  pi.registerTool({
    ...baseRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const ssh = getSsh();
      if (!ssh) return createReadTool(ctx.cwd).execute(id, params, signal, onUpdate);
      const remoteCwd = mapCwdToRemote(ctx.cwd, ssh);
      return createReadTool(remoteCwd, { operations: createRemoteReadOps(getSsh, signal) }).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...baseWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const ssh = getSsh();
      if (!ssh) return createWriteTool(ctx.cwd).execute(id, params, signal, onUpdate);
      const remoteCwd = mapCwdToRemote(ctx.cwd, ssh);
      return createWriteTool(remoteCwd, { operations: createRemoteWriteOps(getSsh, signal) }).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...baseEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const ssh = getSsh();
      if (!ssh) return createEditTool(ctx.cwd).execute(id, params, signal, onUpdate);
      const remoteCwd = mapCwdToRemote(ctx.cwd, ssh);
      return createEditTool(remoteCwd, { operations: createRemoteEditOps(getSsh, signal) }).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...baseBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const ssh = getSsh();
      if (!ssh) return createBashTool(ctx.cwd).execute(id, params, signal, onUpdate);
      const remoteCwd = mapCwdToRemote(ctx.cwd, ssh);
      return createBashTool(remoteCwd, { operations: createRemoteBashOps(getSsh) }).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerCommand("ssh", {
    description: "Show/switch SSH remote execution. Use `/ssh off` to return tools to local execution.",
    getArgumentCompletions: (argumentPrefix) => getCommandCompletions(activeSsh, argumentPrefix),
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (!trimmed) {
        if (ctx.hasUI) {
          const status = activeSsh
            ? `SSH: ${activeSsh.remote}:${mapCwdToRemote(ctx.cwd, activeSsh)} (disable: /ssh off)`
            : `${SSH_OFF_TEXT}. Enable with /ssh host:/path.`;
          ctx.ui.notify(status, "info");
        }
        return;
      }

      if (["off", "disable", "clear"].includes(trimmed)) {
        await applyState(null, ctx, { persist: true });
        pi.sendMessage({
          customType: "ssh-state-change",
          content: "SSH mode disabled. All tool calls (read, write, edit, bash) and user ! commands now execute locally.",
          display: true,
        }, { triggerTurn: false });
        return;
      }

      try {
        const nextState = await resolveSshTarget(trimmed, ctx.cwd);
        await applyState(nextState, ctx, { persist: true });
        pi.sendMessage({
          customType: "ssh-state-change",
          content: `SSH mode enabled: ${nextState.remote}:${nextState.remoteRootCwd}\nAll tool calls (read, write, edit, bash) and user ! commands now execute on this remote host.\nTo return tools to local execution, run /ssh off.`,
          display: true,
        }, { triggerTurn: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Failed to enable SSH mode: ${message}`, "error");
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const flag = pi.getFlag("ssh");
    const shouldNotify = !event.reason || event.reason === "startup" || event.reason === "reload";

    if (typeof flag === "string" && flag.trim()) {
      try {
        await applyState(await resolveSshTarget(flag, ctx.cwd), ctx, {
          notify: shouldNotify,
          persist: true,
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Failed to initialize SSH mode from --ssh: ${message}`, "error");
      }
    }

    restoreState(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreState(ctx);
  });

  pi.on("user_bash", () => {
    if (!getSsh()) return;
    return { operations: createRemoteBashOps(getSsh, { mapLocalCwd: true }) };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const ssh = getSsh();
    if (!ssh) return;

    const remoteCwd = mapCwdToRemote(ctx.cwd, ssh);
    return {
      systemPrompt: event.systemPrompt.replace(
        `Current working directory: ${ctx.cwd}`,
        `Current working directory: ${remoteCwd} (via SSH: ${ssh.remote})`,
      ),
    };
  });
}
