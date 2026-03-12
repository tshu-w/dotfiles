/**
 * SSH Remote Execution Extension
 *
 * Features:
 * - `--ssh user@host[:/remote/path]` startup flag
 * - `/ssh` slash command to view/switch/disable SSH mode
 * - argument completions from ~/.ssh/config
 * - subagent inheritance via environment variables
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

const ENV_REMOTE = "PI_SSH_REMOTE";
const ENV_REMOTE_ROOT_CWD = "PI_SSH_REMOTE_CWD";
const ENV_LOCAL_ROOT_CWD = "PI_SSH_LOCAL_CWD";
const ENTRY_TYPE = "ssh-state";

const SSH_OFF_TEXT = "SSH: off";
const SSH_INACTIVE_ERROR = "SSH mode is not active";
const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

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

type StatusUI = {
  setStatus: (key: string, text: string | undefined) => void;
  theme: { fg: (color: string, text: string) => string };
};

type NotifyUI = StatusUI & {
  notify: (text: string, level?: "info" | "warning" | "error") => void;
};

type StatusContext = {
  hasUI: boolean;
  ui: StatusUI;
};

type MutationContext = {
  hasUI: boolean;
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

function sshExec(remote: string, command: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [remote, command], { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (data) => stdoutChunks.push(data));
    child.stderr.on("data", (data) => stderrChunks.push(data));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`SSH failed (${code}): ${Buffer.concat(stderrChunks).toString()}`));
        return;
      }
      resolve(Buffer.concat(stdoutChunks));
    });
  });
}

function localToRemotePath(localPath: string, state: SshState): string {
  // Handle remote absolute paths directly (agent may use paths from the SSH CWD prompt)
  if (localPath.startsWith(state.remoteRootCwd)) {
    return localPath;
  }

  const absolutePath = path.resolve(localPath);
  const absoluteRoot = path.resolve(state.localRootCwd);
  const relative = path.relative(absoluteRoot, absolutePath);

  const isWithinRoot =
    relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));

  if (!isWithinRoot) return absolutePath;

  const posixRelative = relative.split(path.sep).filter(Boolean).join("/");
  return posixRelative ? path.posix.join(state.remoteRootCwd, posixRelative) : state.remoteRootCwd;
}

function getCurrentRemoteCwd(state: SshState): string {
  return localToRemotePath(process.cwd(), state);
}

function requireSshState(getSsh: () => SshState | null): SshState {
  const ssh = getSsh();
  if (!ssh) throw new Error(SSH_INACTIVE_ERROR);
  return ssh;
}

function createRemoteReadOps(getSsh: () => SshState | null): ReadOperations {
  return {
    readFile: async (filePath) => {
      const ssh = requireSshState(getSsh);
      return sshExec(ssh.remote, `cat ${JSON.stringify(localToRemotePath(filePath, ssh))}`);
    },
    access: async (filePath) => {
      const ssh = requireSshState(getSsh);
      await sshExec(ssh.remote, `test -r ${JSON.stringify(localToRemotePath(filePath, ssh))}`);
    },
    detectImageMimeType: async (filePath) => {
      const ssh = getSsh();
      if (!ssh) return null;

      try {
        const result = await sshExec(ssh.remote, `file --mime-type -b ${JSON.stringify(localToRemotePath(filePath, ssh))}`);
        const mimeType = result.toString().trim();
        return IMAGE_MIME_TYPES.includes(mimeType) ? mimeType : null;
      } catch {
        return null;
      }
    },
  };
}

function createRemoteWriteOps(getSsh: () => SshState | null): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      const ssh = requireSshState(getSsh);
      const base64 = Buffer.from(content).toString("base64");
      await sshExec(
        ssh.remote,
        `echo ${JSON.stringify(base64)} | base64 -d > ${JSON.stringify(localToRemotePath(filePath, ssh))}`,
      );
    },
    mkdir: async (dirPath) => {
      const ssh = requireSshState(getSsh);
      await sshExec(ssh.remote, `mkdir -p ${JSON.stringify(localToRemotePath(dirPath, ssh))}`);
    },
  };
}

function createRemoteEditOps(getSsh: () => SshState | null): EditOperations {
  const readOps = createRemoteReadOps(getSsh);
  const writeOps = createRemoteWriteOps(getSsh);

  return {
    readFile: readOps.readFile,
    access: readOps.access,
    writeFile: writeOps.writeFile,
  };
}

function createRemoteBashOps(getSsh: () => SshState | null): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        let ssh: SshState;
        try {
          ssh = requireSshState(getSsh);
        } catch (error) {
          reject(error);
          return;
        }

        const remoteCwd = localToRemotePath(cwd, ssh);
        const remoteCommand = `cd ${JSON.stringify(remoteCwd)} && ${command}`;
        const child = spawn("ssh", [ssh.remote, remoteCommand], { stdio: ["ignore", "pipe", "pipe"] });
        let timedOut = false;
        const timer = timeout
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeout * 1000)
          : undefined;

        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });

        const onAbort = () => child.kill();
        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      }),
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
  const remoteRootCwd = remotePath ? remotePath : (await sshExec(remote, "pwd")).toString().trim();

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

function formatStatusText(state: SshState | null): string {
  if (!state) return SSH_OFF_TEXT;
  return `SSH: ${state.remote}:${getCurrentRemoteCwd(state)}`;
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

function findPersistedState(ctx: SessionRestoreContext): SshState | null {
  const entry = ctx.sessionManager
    .getEntries()
    .filter((item) => item.type === "custom" && item.customType === ENTRY_TYPE)
    .pop();

  return deserializeState(entry?.data);
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let activeSsh: SshState | null = null;

  const getSsh = () => activeSsh;

  const updateStatus = (ctx: StatusContext) => {
    if (!ctx.hasUI) return;

    if (!activeSsh) {
      ctx.ui.setStatus("ssh", undefined);
      return;
    }

    ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", formatStatusText(activeSsh)));
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
      ctx.ui.notify(activeSsh ? `SSH mode: ${activeSsh.remote}:${getCurrentRemoteCwd(activeSsh)}` : "SSH mode disabled", "info");
    }
  };

  const restoreState = (ctx: SessionRestoreContext) => {
    activeSsh = loadStateFromEnv() ?? findPersistedState(ctx);
    writeStateToEnv(activeSsh);
    updateStatus(ctx);
  };

  const executeWithOptionalSsh = async <TResult>(
    executeLocal: () => Promise<TResult>,
    executeRemote: () => Promise<TResult>,
  ): Promise<TResult> => {
    return getSsh() ? executeRemote() : executeLocal();
  };

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate) {
      return executeWithOptionalSsh(
        () => localRead.execute(id, params, signal, onUpdate),
        () => createReadTool(localCwd, { operations: createRemoteReadOps(getSsh) }).execute(id, params, signal, onUpdate),
      );
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate) {
      return executeWithOptionalSsh(
        () => localWrite.execute(id, params, signal, onUpdate),
        () => createWriteTool(localCwd, { operations: createRemoteWriteOps(getSsh) }).execute(id, params, signal, onUpdate),
      );
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate) {
      return executeWithOptionalSsh(
        () => localEdit.execute(id, params, signal, onUpdate),
        () => createEditTool(localCwd, { operations: createRemoteEditOps(getSsh) }).execute(id, params, signal, onUpdate),
      );
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate) {
      return executeWithOptionalSsh(
        () => localBash.execute(id, params, signal, onUpdate),
        () => createBashTool(localCwd, { operations: createRemoteBashOps(getSsh) }).execute(id, params, signal, onUpdate),
      );
    },
  });

  pi.registerCommand("ssh", {
    description: "Show, enable, or disable SSH remote execution",
    getArgumentCompletions: (argumentPrefix) => getCommandCompletions(activeSsh, argumentPrefix),
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      if (!trimmed) {
        if (ctx.hasUI) ctx.ui.notify(formatStatusText(activeSsh), "info");
        return;
      }

      if (["off", "disable", "clear"].includes(trimmed)) {
        await applyState(null, ctx, { persist: true });
        return;
      }

      try {
        const nextState = await resolveSshTarget(trimmed, localCwd);
        await applyState(nextState, ctx, { persist: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`Failed to enable SSH mode: ${message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const flag = pi.getFlag("ssh");
    if (typeof flag === "string" && flag.trim()) {
      try {
        await applyState(await resolveSshTarget(flag, localCwd), ctx, { notify: true });
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

  pi.on("session_fork", async (_event, ctx) => {
    restoreState(ctx);
  });

  pi.on("user_bash", () => {
    if (!getSsh()) return;
    return { operations: createRemoteBashOps(getSsh) };
  });

  pi.on("before_agent_start", async (event) => {
    const ssh = getSsh();
    if (!ssh) return;

    const remoteCwd = getCurrentRemoteCwd(ssh);
    return {
      systemPrompt: event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${remoteCwd} (via SSH: ${ssh.remote})`,
      ),
    };
  });
}
