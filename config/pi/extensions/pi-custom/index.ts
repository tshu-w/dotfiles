import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CustomEditor,
  DefaultPackageManager,
  DynamicBorder,
  getAgentDir,
  getSettingsListTheme,
  InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, SettingItem, TUI } from "@earendil-works/pi-tui";
import { Container, Key, matchesKey, SettingsList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createCustomPreferences,
  CUSTOM_SETTINGS_ENTRY_TYPE,
  type CustomPreferences,
  type CustomSetting,
} from "./custom-settings.ts";
import {
  installTranscriptHistory,
  type TranscriptHistoryControl,
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

// ─── Session-local state (editor ↔ footer) ───────────────────────────────────

interface CustomRuntimeState {
  activeTui?: TUI;
  sshLocation?: string;
  presetLabel?: string;
}

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
  private runtime: CustomRuntimeState;

  constructor(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    runtime: CustomRuntimeState,
    tui: TUI,
    theme: EditorTheme,
    kb: KeybindingsManager,
  ) {
    super(tui, theme, kb);
    runtime.activeTui = tui;
    this.pi = pi;
    this.ctx = ctx;
    this.runtime = runtime;
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

    const location = this.runtime.sshLocation ?? formatCwd(this.ctx.cwd);
    const sessionName = this.ctx.sessionManager.getSessionName();
    const locationStr = sessionName ? `${location} — ${sessionName}` : location;
    const left = ` ${dim(locationStr)} `;

    const model = this.ctx.model;
    const thinking = this.pi.getThinkingLevel?.() ?? "off";
    const parts: string[] = [];
    if (this.runtime.presetLabel) parts.push(accent(this.runtime.presetLabel));
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

function registerEditor(pi: ExtensionAPI, runtime: CustomRuntimeState): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setEditorComponent(
      (tui, theme, kb) => new TopBorderEditor(pi, ctx, runtime, tui, theme, kb),
    );
  });

  pi.on("session_shutdown", () => {
    runtime.activeTui = undefined;
  });
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function registerFooter(pi: ExtensionAPI, runtime: CustomRuntimeState): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        const statuses = footerData.getExtensionStatuses();

        // Sync SSH location and preset label into shared state for the editor
        const rawSsh = statuses.get("ssh");
        const newSsh = rawSsh ? sanitize(stripAnsi(rawSsh)).replace(/^SSH:\s*/i, "ssh:") : undefined;
        if (newSsh !== runtime.sshLocation) { runtime.sshLocation = newSsh; runtime.activeTui?.requestRender(); }

        const rawPreset = statuses.get("preset");
        const newPreset = rawPreset ? stripAnsi(sanitize(rawPreset)).replace(/^preset:/, "") : undefined;
        if (newPreset !== runtime.presetLabel) { runtime.presetLabel = newPreset; runtime.activeTui?.requestRender(); }

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

interface FastControl {
  isDesired(): boolean;
  isActive(): boolean;
  setDesired(value: boolean): void;
}

function registerFast(
  pi: ExtensionAPI,
  runtime: CustomRuntimeState,
  initialDesired: boolean,
): FastControl {
  let desired = initialDesired;
  let model: { provider?: string; id?: string } | undefined;
  let ui: ExtensionContext["ui"] | undefined;

  const isActive = () => desired && model?.provider === "openai-codex";
  const syncStatus = (target = ui) => {
    target?.setStatus?.(FAST_STATUS_KEY, isActive() ? "fast" : undefined);
    runtime.activeTui?.requestRender();
  };
  const setDesired = (value: boolean, target = ui) => {
    desired = value;
    syncStatus(target);
  };

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    model = ctx.model;
    syncStatus(ctx.ui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus?.(FAST_STATUS_KEY, undefined);
    ui = undefined;
  });

  pi.on("model_select", (event, ctx) => {
    ui = ctx.ui;
    model = event.model;
    syncStatus(ctx.ui);
  });

  pi.on("before_provider_request", (event: BeforeProviderRequestEvent) => {
    if (!isActive()) return undefined;
    if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return undefined;
    return { ...event.payload, service_tier: "priority" };
  });

  return {
    isDesired: () => desired,
    isActive,
    setDesired,
  };
}

// ─── Custom settings ─────────────────────────────────────────────────────────

const CUSTOM_SETTINGS_PATH = join(getAgentDir(), "pi-custom.json");

function registerTranscriptHistory(pi: ExtensionAPI): TranscriptHistoryControl {
  let runtimeControl: TranscriptHistoryControl | undefined;

  pi.on("session_start", (_event, ctx) => {
    runtimeControl?.restore();
    runtimeControl = undefined;
    if (ctx.mode !== "tui") return;
    runtimeControl = installTranscriptHistory(
      InteractiveMode.prototype as unknown as Parameters<typeof installTranscriptHistory>[0],
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
    getStatus: () => runtimeControl?.getStatus() ?? "Recent",
    showOlder: () => runtimeControl?.showOlder(),
    showRecent: () => runtimeControl?.showRecent(),
    showFull: () => runtimeControl?.showFull(),
    omitCompactionOnNextRebuild: (entryId) => {
      runtimeControl?.omitCompactionOnNextRebuild(entryId);
    },
    restore: () => {
      runtimeControl?.restore();
      runtimeControl = undefined;
    },
  };
}

type PreferencePanelItem = CustomSetting | "transcriptHistory";

interface PreferencesPanelActions {
  get(): ReturnType<CustomPreferences["get"]>;
  getHistoryStatus(): string;
  toggleSession(field: CustomSetting): void;
  saveGlobal(field: CustomSetting): void;
  resetSession(field: CustomSetting): void;
  showOlderHistory(): void;
  showRecentHistory(): void;
  showFullHistory(): void;
}

export class PreferencesPanel implements Component {
  private selected = 0;
  private readonly fields: PreferencePanelItem[] = [
    "fast",
    "transcriptOptimization",
    "transcriptHistory",
  ];
  private readonly settingsList: SettingsList;
  private readonly container = new Container();

  constructor(
    private readonly theme: Theme,
    private readonly actions: PreferencesPanelActions,
    private readonly requestRender: () => void,
    private readonly close: () => void,
  ) {
    const items: SettingItem[] = [
      {
        id: "fast",
        label: "Fast mode",
        description: "Use OpenAI priority service tier with the openai-codex provider.",
        currentValue: "",
      },
      {
        id: "transcriptOptimization",
        label: "Transcript optimization",
        description: "Optimize long transcript rendering with memoization and background warm-up.",
        currentValue: "",
      },
      {
        id: "transcriptHistory",
        label: "Transcript history",
        description: "Load older compaction intervals into the TUI without changing model context.",
        currentValue: "",
      },
    ];
    const baseTheme = getSettingsListTheme();
    this.settingsList = new SettingsList(
      items,
      items.length,
      {
        ...baseTheme,
        hint: () => baseTheme.hint(this.helpText()),
      },
      () => {},
      this.close,
    );
    this.container.addChild(new DynamicBorder());
    this.container.addChild(this.settingsList);
    this.container.addChild(new DynamicBorder());
  }

  private helpText(): string {
    return this.fields[this.selected] === "transcriptHistory"
      ? "  Enter/Space load older · r recent · f full · Esc cancel"
      : "  Enter/Space toggle · g save global · r reset · Esc cancel";
  }

  private formatScopedValue(value: string, scope: "global" | "session"): string {
    return `${value.padEnd(8)}${this.theme.fg("dim", `[${scope}]`)}`;
  }

  private syncValues(): void {
    const settings = this.actions.get();
    this.settingsList.updateValue(
      "fast",
      this.formatScopedValue(settings.fast.value ? "On" : "Off", settings.fast.scope),
    );
    this.settingsList.updateValue(
      "transcriptOptimization",
      this.formatScopedValue(
        settings.transcriptOptimization.value ? "On" : "Off",
        settings.transcriptOptimization.scope,
      ),
    );
    this.settingsList.updateValue("transcriptHistory", this.actions.getHistoryStatus());
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selected = (this.selected + this.fields.length - 1) % this.fields.length;
      this.settingsList.handleInput(data);
    } else if (matchesKey(data, Key.down)) {
      this.selected = (this.selected + 1) % this.fields.length;
      this.settingsList.handleInput(data);
    } else if (matchesKey(data, Key.escape)) {
      this.close();
      return;
    } else {
      const field = this.fields[this.selected]!;
      if (field === "transcriptHistory") {
        if (data === " " || matchesKey(data, Key.enter)) this.actions.showOlderHistory();
        else if (data === "r") this.actions.showRecentHistory();
        else if (data === "f") this.actions.showFullHistory();
        else return;
      } else if (data === " " || matchesKey(data, Key.enter)) {
        this.actions.toggleSession(field);
      } else if (data === "g") {
        this.actions.saveGlobal(field);
      } else if (data === "r") {
        this.actions.resetSession(field);
      } else {
        return;
      }
    }
    this.syncValues();
    this.requestRender();
  }

  render(width: number): string[] {
    this.syncValues();
    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
  }
}

function registerCustomSettings(
  pi: ExtensionAPI,
  preferences: CustomPreferences,
  fastControl: FastControl,
  transcriptHistory: TranscriptHistoryControl,
): void {
  const summary = () => {
    const settings = preferences.get();
    const fast = fastControl.isDesired()
      ? fastControl.isActive() ? "on" : "requested (openai-codex only)"
      : "off";
    return [
      `Fast mode: ${fast} (${settings.fast.scope})`,
      `Transcript optimization: ${settings.transcriptOptimization.value ? "on" : "off"} (${settings.transcriptOptimization.scope})`,
      `Transcript history: ${transcriptHistory.getStatus()}`,
    ].join("; ");
  };

  const toggleSession = (field: CustomSetting): void => {
    const settings = preferences.get();
    if (field === "fast") preferences.setSession(field, !settings.fast.value);
    else preferences.setSession(field, !settings.transcriptOptimization.value);
  };

  const showPanel = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(summary(), "info");
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => new PreferencesPanel(
        theme,
        {
          get: () => preferences.get(),
          getHistoryStatus: () => transcriptHistory.getStatus(),
          toggleSession,
          saveGlobal: (field) => preferences.saveGlobal(field),
          resetSession: (field) => preferences.resetSession(field),
          showOlderHistory: () => transcriptHistory.showOlder(),
          showRecentHistory: () => transcriptHistory.showRecent(),
          showFullHistory: () => transcriptHistory.showFull(),
        },
        () => tui.requestRender(),
        () => done(),
      ),
    );
  };

  pi.registerCommand("preferences", {
    description: "Configure personal runtime preferences",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /preferences", "error");
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
  const preferences = createCustomPreferences({
    path: CUSTOM_SETTINGS_PATH,
    appendSession: (settings) => pi.appendEntry(CUSTOM_SETTINGS_ENTRY_TYPE, settings),
  });
  const restorePreferences = (ctx: ExtensionContext) => {
    preferences.restore(ctx.sessionManager.getBranch());
  };
  pi.on("session_start", (_event, ctx) => restorePreferences(ctx));
  pi.on("session_tree", (_event, ctx) => restorePreferences(ctx));

  const initial = preferences.get();
  const runtime: CustomRuntimeState = {};
  const transcriptHistory = registerTranscriptHistory(pi);
  const renderPerf = registerRenderPerf(pi, initial.transcriptOptimization.value);

  registerPackageAutoUpdate(pi);
  registerEditor(pi, runtime);
  registerFooter(pi, runtime);
  const fastControl = registerFast(pi, runtime, initial.fast.value);
  const applyPreferences = () => {
    const settings = preferences.get();
    fastControl.setDesired(settings.fast.value);
    renderPerf.setEnabled(settings.transcriptOptimization.value);
  };
  preferences.onChange(applyPreferences);
  applyPreferences();

  registerRestart(pi);
  registerSystemTheme(pi);
  registerUvGuard(pi);
  registerJjGuard(pi);
  registerCustomSettings(pi, preferences, fastControl, transcriptHistory);
}
