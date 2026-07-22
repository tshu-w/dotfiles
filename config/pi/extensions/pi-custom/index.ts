import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CustomEditor,
  DefaultPackageManager,
  DynamicBorder,
  getAgentDir,
  getSettingsListTheme,
  InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, SettingItem, TUI } from "@earendil-works/pi-tui";
import { Container, SettingsList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  installTranscriptView,
  type TranscriptView,
  type TranscriptViewControl,
} from "./full-transcript.ts";
import { registerUvGuard, registerJjGuard } from "./guards.ts";
import { registerRenderPerf, type RenderPerfControl } from "./render-perf.ts";
import { registerSystemTheme } from "./system-theme.ts";

// ─── Formatting utils ─────────────────────────────────────────────────────────

function shortenPath(path: string): string {
  const parts = path.split(sep);
  return parts
    .map((part, i) => {
      if (!part || i === 0 || i === parts.length - 1) return part;
      return Array.from(part)[0] ?? part;
    })
    .join(sep);
}

function formatCwd(cwd: string): string {
  const home = homedir();
  const rel = relative(resolve(home), resolve(cwd));
  const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  const display = inside ? (rel === "" ? "~" : `~${sep}${rel}`) : resolve(cwd);
  return shortenPath(display);
}

function formatTokens(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

function sanitize(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function remainingColor(remaining: number): "dim" | "warning" | "error" {
  if (remaining <= 25) return "error";
  if (remaining <= 50) return "warning";
  return "dim";
}

function formatSubscriptionStatus(
  text: string,
  fg: (color: "dim" | "warning" | "error", s: string) => string,
): string {
  const normalized = sanitize(text);
  if (!normalized) return "";
  let out = "";
  let last = 0;
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)%/g)) {
    const idx = match.index ?? 0;
    const used = Number(match[1]);
    const remaining = Math.max(0, Math.min(100, Math.round(100 - used)));
    out += fg("dim", normalized.slice(last, idx));
    out += fg(remainingColor(remaining), `${remaining}%`);
    last = idx + match[0].length;
  }
  out += fg("dim", normalized.slice(last));
  return out;
}

function fitBorder(
  left: string,
  right: string,
  width: number,
  border: (s: string) => string,
): string {
  if (width <= 0) return "";
  if (width === 1) return border("─");
  let l = left;
  let r = right;
  const fixed = 4;
  const minGap = 3;
  while (fixed + visibleWidth(l) + visibleWidth(r) + minGap > width && visibleWidth(r) > 0) {
    r = truncateToWidth(r, Math.max(0, visibleWidth(r) - 1), "");
  }
  while (fixed + visibleWidth(l) + visibleWidth(r) + minGap > width && visibleWidth(l) > 0) {
    l = truncateToWidth(l, Math.max(0, visibleWidth(l) - 1), "");
  }
  const gap = Math.max(minGap, width - fixed - visibleWidth(l) - visibleWidth(r));
  return `${border("─").repeat(2)}${l}${border("─").repeat(gap)}${r}${border("─").repeat(2)}`;
}

// ─── Shared state (editor ↔ footer) ──────────────────────────────────────────

let activeTui: TUI | undefined;
let sshLocation: string | undefined;
let presetLabel: string | undefined;

// ─── Package auto-update ──────────────────────────────────────────────────────

const PACKAGE_UPDATE_STATUS_KEY = "pi-custom-package-update";
const PACKAGE_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PACKAGE_UPDATE_STALE_LOCK_MS = 2 * 60 * 60 * 1000;

let packageUpdateBannerSuppressed = false;
let packageUpdateStarted = false;

interface PackageUpdateState {
  lastAttempt?: number;
  lastSuccess?: number;
  lastExitCode?: number;
  lastError?: string;
}

function suppressPackageUpdateBanner(): void {
  if (packageUpdateBannerSuppressed) return;
  packageUpdateBannerSuppressed = true;
  const proto = DefaultPackageManager.prototype as {
    checkForAvailableUpdates?: () => Promise<unknown[]>;
  };
  if (typeof proto.checkForAvailableUpdates === "function") {
    proto.checkForAvailableUpdates = async () => [];
  }
}

function getPackageUpdateCacheDir(): string {
  return join(getAgentDir(), "cache", "pi-custom");
}

function readPackageUpdateState(path: string): PackageUpdateState {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageUpdateState;
  } catch {
    return {};
  }
}

function writePackageUpdateState(path: string, state: PackageUpdateState): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function acquirePackageUpdateLock(path: string): boolean {
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs <= PACKAGE_UPDATE_STALE_LOCK_MS) return false;
      rmSync(path, { force: true });
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

function truncateLog(text: string): string {
  return text.length <= 4000 ? text : text.slice(-4000);
}

const PACKAGE_UPDATE_COMMANDS = [
  { command: "pi", args: ["update", "--extensions"] },
  { command: "npm", args: ["update", "-g", "@browserbridge/bbx"] },
] as const;

// Skip `pi update --extensions` while any git package clone has local
// changes, so the updater never clobbers uncommitted work.
async function findDirtyGitPackages(gitRoot: string): Promise<string[]> {
  const dirty: string[] = [];
  let hosts: string[];
  try {
    hosts = await readdir(gitRoot);
  } catch {
    return dirty;
  }
  for (const host of hosts) {
    const hostDir = join(gitRoot, host);
    let owners: string[];
    try {
      owners = await readdir(hostDir);
    } catch {
      continue;
    }
    for (const owner of owners) {
      const ownerDir = join(hostDir, owner);
      let repos: string[];
      try {
        repos = await readdir(ownerDir);
      } catch {
        continue;
      }
      for (const repo of repos) {
        const repoDir = join(ownerDir, repo);
        if (!existsSync(join(repoDir, ".git"))) continue;
        const status = await new Promise<string | undefined>((resolvePorcelain) => {
          execFile("git", ["-C", repoDir, "status", "--porcelain"], { encoding: "utf8" }, (error, stdout) => {
            resolvePorcelain(error ? undefined : stdout);
          });
        });
        if (status === undefined) continue;
        // Only tracked modifications count; ignore untracked files and the
        // package-lock.json churn from pi's own dependency install.
        const changes = status
          .split("\n")
          .filter((line) => line.trim() && !line.startsWith("??") && !line.endsWith("package-lock.json"));
        if (changes.length > 0) dirty.push(`${owner}/${repo}`);
      }
    }
  }
  return dirty;
}

function runUpdateCommand(command: string, args: readonly string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const finish = (code: number, extra = "") => {
      if (settled) return;
      settled = true;
      resolve({ code, output: truncateLog(output + extra) });
    };

    child.stdout?.on("data", (data) => { output = truncateLog(output + data.toString()); });
    child.stderr?.on("data", (data) => { output = truncateLog(output + data.toString()); });
    child.on("error", (error) => finish(-1, `\n${error.message}`));
    child.on("close", (code) => finish(code ?? -1));
  });
}

function registerPackageAutoUpdate(pi: ExtensionAPI): void {
  suppressPackageUpdateBanner();

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    if (packageUpdateStarted || process.env.PI_OFFLINE) return;
    packageUpdateStarted = true;

    const cacheDir = getPackageUpdateCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    const statePath = join(cacheDir, "package-update.json");
    const lockPath = join(cacheDir, "package-update.lock");
    const state = readPackageUpdateState(statePath);
    const now = Date.now();
    if (state.lastAttempt && now - state.lastAttempt < PACKAGE_UPDATE_INTERVAL_MS) return;
    if (!acquirePackageUpdateLock(lockPath)) return;

    writePackageUpdateState(statePath, { ...state, lastAttempt: now });
    // ctx becomes stale after session replacement/reload; UI updates are best-effort.
    const safeUi = (fn: () => void) => { try { fn(); } catch { /* stale ctx */ } };
    safeUi(() => ctx.ui.setStatus?.(PACKAGE_UPDATE_STATUS_KEY, "pkg update…"));

    void (async () => {
      const dirty = await findDirtyGitPackages(join(getAgentDir(), "git"));
      if (dirty.length > 0) {
        safeUi(() => ctx.ui.notify(`pkg update: skipped pi update --extensions (local changes: ${dirty.join(", ")})`, "warning"));
      }
      const commands = dirty.length
        ? PACKAGE_UPDATE_COMMANDS.filter((update) => update.command !== "pi")
        : PACKAGE_UPDATE_COMMANDS;
      let code = 0;
      let output = dirty.length ? `skipped pi update --extensions (local changes: ${dirty.join(", ")})` : "";
      let failedCommand: string | undefined;

      for (const update of commands) {
        const result = await runUpdateCommand(update.command, update.args, ctx.cwd);
        output = truncateLog(`${output}\n$ ${update.command} ${update.args.join(" ")}\n${result.output}`);
        code = result.code;
        if (code !== 0) {
          failedCommand = `${update.command} ${update.args.join(" ")}`;
          break;
        }
      }

      const latest = readPackageUpdateState(statePath);
      writePackageUpdateState(statePath, {
        ...latest,
        lastSuccess: code === 0 ? Date.now() : latest.lastSuccess,
        lastExitCode: code,
        lastError: code === 0 ? undefined : `${failedCommand ?? "update"} failed: ${output.trim() || `exit ${code}`}`,
      });
      rmSync(lockPath, { force: true });
      const statusText = code !== 0 ? "pkg update failed" : dirty.length ? "pkg updated (ext skipped: dirty)" : "pkg updated";
      safeUi(() => ctx.ui.setStatus?.(PACKAGE_UPDATE_STATUS_KEY, statusText));
      setTimeout(() => safeUi(() => ctx.ui.setStatus?.(PACKAGE_UPDATE_STATUS_KEY, undefined)), 15_000).unref();
    })().catch((error: unknown) => {
      writePackageUpdateState(statePath, {
        ...readPackageUpdateState(statePath),
        lastExitCode: -1,
        lastError: error instanceof Error ? error.message : String(error),
      });
      rmSync(lockPath, { force: true });
      safeUi(() => ctx.ui.setStatus?.(PACKAGE_UPDATE_STATUS_KEY, "pkg update failed"));
    });
  });
}

// ─── Editor ───────────────────────────────────────────────────────────────────

class TopBorderEditor extends CustomEditor {
  private pi: ExtensionAPI;
  private ctx: ExtensionContext;

  constructor(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    tui: TUI,
    theme: EditorTheme,
    kb: KeybindingsManager,
  ) {
    super(tui, theme, kb);
    activeTui = tui;
    this.pi = pi;
    this.ctx = ctx;
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;
    lines[0] = this.topBorder(width);
    return lines;
  }

  private topBorder(width: number): string {
    const theme = this.ctx.ui.theme;
    const dim = (s: string) => theme.fg("dim", s);
    const accent = (s: string) => theme.fg("accent", s);
    const border = (s: string) => this.borderColor(s);

    const location = sshLocation ?? formatCwd(this.ctx.cwd);
    const sessionName = this.ctx.sessionManager.getSessionName();
    const locationStr = sessionName ? `${location} — ${sessionName}` : location;
    const left = ` ${dim(locationStr)} `;

    const model = this.ctx.model;
    const thinking = this.pi.getThinkingLevel?.() ?? "off";
    const parts: string[] = [];
    if (presetLabel) parts.push(accent(presetLabel));
    if (model) {
      const modelStr = thinking !== "off"
        ? `${model.provider}/${model.id}:${thinking}`
        : `${model.provider}/${model.id}`;
      parts.push(dim(modelStr));
    }
    const right = parts.length > 0 ? ` ${parts.join(dim(" · "))} ` : " ";

    return fitBorder(left, right, width, border);
  }
}

function registerEditor(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setEditorComponent(
      (tui, theme, kb) => new TopBorderEditor(pi, ctx, tui, theme, kb),
    );
  });

  pi.on("session_shutdown", () => {
    activeTui = undefined;
  });
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function registerFooter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        const statuses = footerData.getExtensionStatuses();

        // Sync SSH location and preset label into shared state for the editor
        const rawSsh = statuses.get("ssh");
        const newSsh = rawSsh ? sanitize(stripAnsi(rawSsh)).replace(/^SSH:\s*/i, "ssh:") : undefined;
        if (newSsh !== sshLocation) { sshLocation = newSsh; activeTui?.requestRender(); }

        const rawPreset = statuses.get("preset");
        const newPreset = rawPreset ? stripAnsi(sanitize(rawPreset)).replace(/^preset:/, "") : undefined;
        if (newPreset !== presetLabel) { presetLabel = newPreset; activeTui?.requestRender(); }

        // Left: token stats + cost + context%
        const dim = (s: string) => theme.fg("dim", s);
        let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
        for (const entry of ctx.sessionManager.getEntries() as any[]) {
          if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message.usage) continue;
          const u = entry.message.usage;
          totalInput += u.input ?? 0;
          totalOutput += u.output ?? 0;
          totalCacheRead += u.cacheRead ?? 0;
          totalCacheWrite += u.cacheWrite ?? 0;
          totalCost += u.cost?.total ?? 0;
        }
        const model = ctx.model;
        const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;

        const statParts: string[] = [];
        if (totalInput) statParts.push(`↑${formatTokens(totalInput)}`);
        if (totalOutput) statParts.push(`↓${formatTokens(totalOutput)}`);
        if (totalCacheRead) statParts.push(`R${formatTokens(totalCacheRead)}`);
        if (totalCacheWrite) statParts.push(`W${formatTokens(totalCacheWrite)}`);
        if (totalCost || usingSubscription) statParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

        const contextUsage = ctx.getContextUsage?.();
        const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
        const pct = contextUsage?.percent ?? 0;
        const ctxStr = pct > 0 ? `${pct.toFixed(1)}%/${formatTokens(contextWindow)}` : `?/${formatTokens(contextWindow)}`;
        const styledCtx = pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : dim(ctxStr);
        const left = statParts.length > 0 ? dim(statParts.join(" ")) + " " + styledCtx : styledCtx;

        // Right: unconsumed extension statuses + subscription status
        const fg = (color: "dim" | "warning" | "error", s: string) => theme.fg(color, s);
        const subUsage = statuses.get("sub-status:usage");
        const subBar = sanitize(statuses.get("sub-bar") ?? "");
        const subStr = subUsage ? formatSubscriptionStatus(subUsage, fg) : subBar ? dim(subBar) : "";
        const consumedStatuses = new Set(["ssh", "preset", "sub-status:usage", "sub-bar"]);
        const extensionStatuses = [...statuses.entries()]
          .filter(([key, value]) => !consumedStatuses.has(key) && sanitize(value).length > 0)
          .map(([, value]) => dim(sanitize(value)));
        const right = [...extensionStatuses, subStr].filter(Boolean).join(dim(" · "));

        const lw = visibleWidth(left);
        const rw = visibleWidth(right);
        if (lw + rw + 1 <= width) return [left + " ".repeat(width - lw - rw) + right];
        const truncLeft = truncateToWidth(left, Math.max(0, width - rw - 1), dim("…"));
        return [truncLeft + (rw > 0 ? " " + right : "")];
      },
    }));
  });
}

// ─── Fast mode ────────────────────────────────────────────────────────────────

const FAST_STATUS_KEY = "pi-openai-fast";

let fastDesired = false;
let fastModel: { provider?: string; id?: string } | undefined;
let fastUi: ExtensionContext["ui"] | undefined;

function isFastActive(): boolean {
  return fastDesired && fastModel?.provider === "openai-codex";
}

function syncFastStatus(ui = fastUi): void {
  ui?.setStatus?.(FAST_STATUS_KEY, isFastActive() ? "fast" : undefined);
  activeTui?.requestRender();
}

function setFastDesired(value: boolean, ui = fastUi): void {
  fastDesired = value;
  syncFastStatus(ui);
}

function registerFast(pi: ExtensionAPI): void {
  pi.registerCommand("fast", {
    description: "Toggle OpenAI priority service tier",
    handler: async (args, ctx) => {
      fastUi = ctx.ui;
      fastModel = ctx.model;
      const action = args.trim().toLowerCase();
      if (action === "on" || action === "enable") setFastDesired(true, ctx.ui);
      else if (action === "off" || action === "disable") setFastDesired(false, ctx.ui);
      else if (action === "status") {
        const state = isFastActive() ? "active" : fastDesired ? "requested (openai-codex only)" : "off";
        ctx.ui.notify(`Fast mode: ${state}`, "info");
        syncFastStatus(ctx.ui);
        return;
      } else {
        setFastDesired(!fastDesired, ctx.ui);
      }
      const state = isFastActive() ? "on" : fastDesired ? "requested (openai-codex only)" : "off";
      ctx.ui.notify(`Fast mode: ${state}`, fastDesired && !isFastActive() ? "warning" : "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    fastUi = ctx.ui;
    fastModel = ctx.model;
    syncFastStatus(ctx.ui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus?.(FAST_STATUS_KEY, undefined);
    fastUi = undefined;
  });

  pi.on("model_select", (event, ctx) => {
    fastUi = ctx.ui;
    fastModel = event.model;
    syncFastStatus(ctx.ui);
  });

  pi.on("before_provider_request", (event: BeforeProviderRequestEvent) => {
    if (!isFastActive()) return undefined;
    if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return undefined;
    return { ...event.payload, service_tier: "priority" };
  });
}

// ─── Custom settings ─────────────────────────────────────────────────────────

const CUSTOM_SETTINGS_PATH = join(getAgentDir(), "pi-custom.json");

interface PiCustomSettings {
  transcriptOptimization: boolean;
  transcriptView: TranscriptView;
}

function readPiCustomSettings(): PiCustomSettings {
  const defaults: PiCustomSettings = {
    transcriptOptimization: true,
    transcriptView: "full",
  };
  if (!existsSync(CUSTOM_SETTINGS_PATH)) return defaults;
  try {
    const value = JSON.parse(readFileSync(CUSTOM_SETTINGS_PATH, "utf8")) as Partial<PiCustomSettings>;
    return {
      transcriptOptimization: typeof value.transcriptOptimization === "boolean"
        ? value.transcriptOptimization
        : defaults.transcriptOptimization,
      transcriptView: value.transcriptView === "full" || value.transcriptView === "compact"
        ? value.transcriptView
        : defaults.transcriptView,
    };
  } catch {
    return defaults;
  }
}

function writePiCustomSettings(settings: PiCustomSettings): void {
  writeFileSync(CUSTOM_SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

function registerTranscriptView(pi: ExtensionAPI, initialView: TranscriptView): TranscriptViewControl {
  let view = initialView;
  let runtimeControl: TranscriptViewControl | undefined;

  pi.on("session_start", (_event, ctx) => {
    runtimeControl?.restore();
    runtimeControl = undefined;
    if (ctx.mode !== "tui") return;
    runtimeControl = installTranscriptView(
      InteractiveMode.prototype as unknown as Parameters<typeof installTranscriptView>[0],
      view,
    );
  });

  pi.on("session_compact", (event) => {
    runtimeControl?.omitCompactionOnNextRebuild(event.compactionEntry.id);
  });

  pi.on("session_shutdown", () => {
    runtimeControl?.restore();
    runtimeControl = undefined;
  });

  return {
    getView: () => view,
    setView: (next) => {
      view = next;
      runtimeControl?.setView(next);
    },
    omitCompactionOnNextRebuild: (entryId) => {
      runtimeControl?.omitCompactionOnNextRebuild(entryId);
    },
    restore: () => {
      runtimeControl?.restore();
      runtimeControl = undefined;
    },
  };
}

function registerCustomSettings(
  pi: ExtensionAPI,
  settings: PiCustomSettings,
  renderPerf: RenderPerfControl,
  transcriptView: TranscriptViewControl,
): void {
  const summary = () => {
    const fast = fastDesired ? isFastActive() ? "on" : "requested (openai-codex only)" : "off";
    return [
      `Fast mode: ${fast}`,
      `Transcript optimization: ${renderPerf.isEnabled() ? "on" : "off"}`,
      `Transcript view: ${transcriptView.getView()}`,
    ].join("; ");
  };

  const showPanel = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(summary(), "info");
      return;
    }
    await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
      const items: SettingItem[] = [
        {
          id: "fast",
          label: "Fast mode",
          description: "Enable OpenAI priority service tier for the openai-codex provider",
          currentValue: fastDesired ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "transcript-optimization",
          label: "Transcript optimization",
          description: "Optimize long transcript rendering with memoization and background warm-up",
          currentValue: renderPerf.isEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "transcript-view",
          label: "Transcript view",
          description: "Show full active-branch history or compacted history without changing model context",
          currentValue: transcriptView.getView(),
          values: ["full", "compact"],
        },
      ];
      const container = new Container();
      container.addChild(new DynamicBorder());
      const settingsList = new SettingsList(
        items,
        Math.min(items.length, 10),
        getSettingsListTheme(),
        (id, newValue) => {
          if (id === "fast") {
            setFastDesired(newValue === "on");
          } else if (id === "transcript-optimization") {
            settings.transcriptOptimization = newValue === "on";
            renderPerf.setEnabled(settings.transcriptOptimization);
            writePiCustomSettings(settings);
          } else if (id === "transcript-view") {
            settings.transcriptView = newValue === "full" ? "full" : "compact";
            transcriptView.setView(settings.transcriptView);
            writePiCustomSettings(settings);
          }
          tui.requestRender();
        },
        () => done(),
      );
      container.addChild(settingsList);
      container.addChild(new DynamicBorder());
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          settingsList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  };

  pi.registerCommand("custom", {
    description: "Configure persistent custom runtime settings",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /custom", "error");
        return;
      }
      await showPanel(ctx);
    },
  });
}

// ─── Restart ─────────────────────────────────────────────────────────────────

// ctx.shutdown() runs the normal graceful-quit flow (deferred until idle,
// terminal restored), then an "exit" hook replaces the dying process via
// process.execve with `pi --session <current> [message]`. Same pid, so the
// shell keeps treating it as the foreground job and the new TUI takes over
// cleanly. Optional command text becomes pi's initial message after startup.
//
// Launch flags (--model, -e, ...) are not carried over; model and thinking
// level are restored from the session itself. If execve throws, pi just
// exits normally — resume manually with `pi -c`.
function registerRestart(pi: ExtensionAPI): void {
  pi.registerCommand("restart", {
    description: "Restart pi process; optional text is submitted after restart",
    handler: async (rawArgs, ctx) => {
      const continuation = rawArgs.trim();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const args = [process.execPath, process.argv[1]];
      if (sessionFile) args.push("--session", sessionFile);
      if (continuation) args.push(continuation);
      process.once("exit", () => {
        try {
          process.execve(process.execPath, args, process.env as Record<string, string>);
        } catch {
          // fall through to a normal exit
        }
      });
      const destination = sessionFile ? " into current session" : "";
      const nextStep = continuation ? " and continuing" : "";
      ctx.ui.notify(`Restarting${destination}${nextStep}...`, "info");
      ctx.shutdown();
    },
  });
}

// ─── Main export ─────────────────────────────────────────────────────────────

export default function piCustom(pi: ExtensionAPI) {
  const settings = readPiCustomSettings();
  const transcriptView = registerTranscriptView(pi, settings.transcriptView);
  const renderPerf = registerRenderPerf(pi, settings.transcriptOptimization);

  registerPackageAutoUpdate(pi);
  registerEditor(pi);
  registerFooter(pi);
  registerFast(pi);
  registerRestart(pi);
  registerSystemTheme(pi);
  registerUvGuard(pi);
  registerJjGuard(pi);
  registerCustomSettings(pi, settings, renderPerf, transcriptView);
}
