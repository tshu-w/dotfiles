import type {
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
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createCustomPreferences,
  CUSTOM_SETTINGS_ENTRY_TYPE,
  type CustomPreferences,
  type CustomSetting,
} from "./custom-settings.ts";
import { type CodexControl, registerCodex } from "./codex.ts";
import { registerClaude } from "./claude.ts";
import {
  installTranscriptHistory,
  type TranscriptHistoryControl,
} from "./full-transcript.ts";
import { registerUvGuard, registerJjHint } from "./guards.ts";
import { registerNotify } from "./notify.ts";
import { registerRenderPerf, type RenderPerfControl } from "./render-perf.ts";
import { registerClampedOutput } from "./clamped-output.ts";
import { installTranscriptDisplay } from "./transcript-display.ts";

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
  envLocation?: string;
}

// ─── Package auto-update ──────────────────────────────────────────────────────

const PACKAGE_UPDATE_STATUS_KEY = "pi-custom-package-update";
const PACKAGE_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PACKAGE_UPDATE_STALE_LOCK_MS = 60 * 1000;

type PackageUpdateCheck = () => Promise<unknown[]>;

let packageUpdateBannerSuppressed = false;
let packageUpdateBannerUsers = 0;
let packageUpdateCheckOriginal: PackageUpdateCheck | undefined;
let packageUpdateCheckPatched: PackageUpdateCheck | undefined;
let packageUpdateStarted = false;

interface PackageUpdateState {
  lastAttempt?: number;
}

function suppressPackageUpdateBanner(): void {
  packageUpdateBannerUsers++;
  if (packageUpdateBannerSuppressed) return;
  packageUpdateBannerSuppressed = true;
  const proto = DefaultPackageManager.prototype as {
    checkForAvailableUpdates?: PackageUpdateCheck;
  };
  if (typeof proto.checkForAvailableUpdates === "function") {
    packageUpdateCheckOriginal = proto.checkForAvailableUpdates;
    packageUpdateCheckPatched = async () => [];
    proto.checkForAvailableUpdates = packageUpdateCheckPatched;
  }
}

function restorePackageUpdateBanner(): void {
  packageUpdateBannerUsers = Math.max(0, packageUpdateBannerUsers - 1);
  if (packageUpdateBannerUsers > 0 || !packageUpdateBannerSuppressed) return;
  const proto = DefaultPackageManager.prototype as {
    checkForAvailableUpdates?: PackageUpdateCheck;
  };
  if (proto.checkForAvailableUpdates === packageUpdateCheckPatched && packageUpdateCheckOriginal) {
    proto.checkForAvailableUpdates = packageUpdateCheckOriginal;
  }
  packageUpdateCheckOriginal = undefined;
  packageUpdateCheckPatched = undefined;
  packageUpdateBannerSuppressed = false;
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

// Claim the next update, so two Pi instances starting together don't both run it. The lock is
// held only while lastAttempt is read and written; an older lock was left by a crash in between.
export function claimPackageUpdate(statePath: string, lockPath: string, now: number): boolean {
  const lock = () => { try { writeFileSync(lockPath, "", { flag: "wx" }); return true; } catch { return false; } };
  if (!lock()) {
    try {
      if (now - statSync(lockPath).mtimeMs < PACKAGE_UPDATE_STALE_LOCK_MS) return false;
    } catch { /* released meanwhile */ }
    rmSync(lockPath, { force: true });
    if (!lock()) return false;
  }
  try {
    const state = readPackageUpdateState(statePath);
    if (state.lastAttempt && now - state.lastAttempt < PACKAGE_UPDATE_INTERVAL_MS) return false;
    writePackageUpdateState(statePath, { ...state, lastAttempt: now });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(lockPath, { force: true });
  }
}

const PACKAGE_UPDATE_COMMANDS = [
  { command: "pi", args: ["update", "--extensions"] },
  { command: "npm", args: ["update", "-g", "@browserbridge/bbx"] },
] as const;

// Skip `pi update --extensions` while any git package clone has work that its
// `git reset --hard` and `git clean -fdx` would lose: changes, untracked files,
// unpushed commits, or a jj repo (`.jj` is deleted) not at its remote's head.
export async function findDirtyGitPackages(gitRoot: string): Promise<string[]> {
  const dirty: string[] = [];
  const list = (dir: string) => readdir(dir).catch(() => [] as string[]);
  for (const host of await list(gitRoot)) {
    for (const owner of await list(join(gitRoot, host))) {
      for (const repo of await list(join(gitRoot, host, owner))) {
        const repoDir = join(gitRoot, host, owner, repo);
        if (!existsSync(join(repoDir, ".git"))) continue;
        const git = (...args: string[]) => new Promise<string | undefined>((resolveGit) => {
          execFile("git", ["-C", repoDir, ...args], { encoding: "utf8", timeout: 30_000 }, (error, stdout) => {
            resolveGit(error ? undefined : stdout.trim());
          });
        });
        const status = await git("status", "--porcelain");
        if (status === undefined) continue;
        // Ignore the package-lock.json churn from pi's own dependency install.
        let unsafe = status.split("\n").some((line) => line.trim() && !line.endsWith("package-lock.json"))
          || !!(await git("rev-list", "-n1", "HEAD", "--not", "--remotes"));
        if (!unsafe && existsSync(join(repoDir, ".jj"))) {
          const remote = await git("ls-remote", "origin", "HEAD");
          unsafe = !remote || remote.split(/\s/)[0] !== await git("rev-parse", "HEAD");
        }
        if (unsafe) dirty.push(`${owner}/${repo}`);
      }
    }
  }
  return dirty;
}

function runUpdateCommand(command: string, args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd, env: process.env, stdio: "ignore" });
    // An error (e.g. a missing executable) may come without a close event.
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

function registerPackageAutoUpdate(pi: ExtensionAPI): void {
  suppressPackageUpdateBanner();

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" || ctx.mode !== "tui") return;
    if (packageUpdateStarted || process.env.PI_OFFLINE) return;
    packageUpdateStarted = true;

    const cacheDir = getPackageUpdateCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    const statePath = join(cacheDir, "package-update.json");
    const lockPath = join(cacheDir, "package-update.lock");
    if (!claimPackageUpdate(statePath, lockPath, Date.now())) return;
    // ctx becomes stale after session replacement/reload; UI updates are best-effort.
    const safeUi = (fn: () => void) => { try { fn(); } catch { /* stale ctx */ } };
    safeUi(() => ctx.ui.setStatus(PACKAGE_UPDATE_STATUS_KEY, "pkg update…"));

    void (async () => {
      const dirty = await findDirtyGitPackages(join(getAgentDir(), "git"));
      if (dirty.length > 0) {
        safeUi(() => ctx.ui.notify(`pkg update: skipped pi update --extensions (local changes: ${dirty.join(", ")})`, "warning"));
      }
      const commands = dirty.length
        ? PACKAGE_UPDATE_COMMANDS.filter((update) => update.command !== "pi")
        : PACKAGE_UPDATE_COMMANDS;
      let code = 0;
      for (const update of commands) {
        code = await runUpdateCommand(update.command, update.args, ctx.cwd);
        if (code !== 0) break;
      }
      const statusText = code !== 0 ? "pkg update failed" : dirty.length ? "pkg updated (extensions skipped)" : "pkg updated";
      safeUi(() => ctx.ui.setStatus(PACKAGE_UPDATE_STATUS_KEY, statusText));
      setTimeout(() => safeUi(() => ctx.ui.setStatus(PACKAGE_UPDATE_STATUS_KEY, undefined)), 15_000).unref();
    })().catch(() => {
      safeUi(() => ctx.ui.setStatus(PACKAGE_UPDATE_STATUS_KEY, "pkg update failed"));
      setTimeout(() => safeUi(() => ctx.ui.setStatus(PACKAGE_UPDATE_STATUS_KEY, undefined)), 15_000).unref();
    });
  });

  pi.on("session_shutdown", () => {
    restorePackageUpdateBanner();
  });
}

// ─── Editor ───────────────────────────────────────────────────────────────────

export class TopBorderEditor extends CustomEditor {
  private statusIndicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];
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
    super(tui, theme, kb, { embedWorkingStatus: true });
    runtime.activeTui = tui;
    this.pi = pi;
    this.ctx = ctx;
    this.runtime = runtime;
  }

  setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
    this.statusIndicator = indicator;
    super.setWorkingStatusIndicator(indicator);
  }

  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    if (hiddenLineCount > 0) return super.renderTopBorder(width, hiddenLineCount);
    if (width <= 0) return "";
    if (this.statusIndicator) {
      const status = this.statusIndicator.renderInBorder(width);
      // fitBorder needs four border columns, three gap columns, and two status spaces.
      const wraps = this.statusIndicator.render(width + 2).length > 2;
      if (!wraps && visibleWidth(status) + 9 <= width) return this.topBorder(width, ` ${status} `);
      const spinner = this.statusIndicator.renderSpinnerInBorder(width);
      const remaining = Math.max(0, width - visibleWidth(spinner));
      const prefix = Math.min(2, remaining);
      return this.borderColor("─".repeat(prefix)) + spinner + this.borderColor("─".repeat(remaining - prefix));
    }
    if (width < 7) return super.renderTopBorder(width, hiddenLineCount);
    return this.topBorder(width);
  }

  private topBorder(width: number, statusLeft?: string): string {
    const theme = this.ctx.ui.theme;
    const dim = (s: string) => theme.fg("dim", s);
    const border = (s: string) => this.borderColor(s);

    const location = this.runtime.envLocation ?? formatCwd(this.ctx.cwd);
    const sessionName = this.ctx.sessionManager.getSessionName();
    const locationStr = sessionName ? `${location} — ${sessionName}` : location;
    const left = statusLeft ?? ` ${dim(locationStr)} `;

    const model = this.ctx.model;
    const thinking = this.pi.getThinkingLevel();
    const parts: string[] = [];
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
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(
      (tui, theme, kb) => new TopBorderEditor(pi, ctx, runtime, tui, theme, kb),
    );
  });

  pi.on("session_shutdown", () => {
    runtime.activeTui = undefined;
  });
}

// ─── Footer ───────────────────────────────────────────────────────────────────

export function registerFooter(pi: ExtensionAPI, runtime: CustomRuntimeState): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
      let cached: {
        manager: typeof ctx.sessionManager;
        sessionId: string;
        leafId: string | null;
        totalInput: number; totalOutput: number; totalCacheRead: number; totalCacheWrite: number; totalCost: number;
        latestCacheHitRate: number | undefined;
      } | undefined;
      let contextCache: {
        totals: typeof cached;
        model: typeof ctx.model;
        usage: ReturnType<typeof ctx.getContextUsage>;
      } | undefined;
      return {
        invalidate() {},
        dispose() { unsubscribeBranch(); },
        render(width: number): string[] {
          const statuses = footerData.getExtensionStatuses();

          // Sync the pi-exec location into shared state for the editor
          const rawEnv = statuses.get("env");
          const newEnv = rawEnv ? sanitize(stripAnsi(rawEnv)).replace(/^(SSH|Docker):\s*/i, (_, kind) => `${kind.toLowerCase()}:`) : undefined;
          if (newEnv !== runtime.envLocation) { runtime.envLocation = newEnv; runtime.activeTui?.requestRender(); }


          // Left: token stats + cost + context%
          const dim = (s: string) => theme.fg("dim", s);
          const manager = ctx.sessionManager;
          const sessionId = manager.getSessionId();
          const leafId = manager.getLeafId();
          // Entries are append-only and every append moves the leaf. Avoid copying/scanning on every frame.
          if (!cached || cached.manager !== manager || cached.sessionId !== sessionId || cached.leafId !== leafId) {
            let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
            let latestCacheHitRate: number | undefined;
            for (const entry of manager.getEntries() as any[]) {
              const u = entry.type === "message"
                && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")
                ? entry.message.usage
                : (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage")
                  ? entry.usage
                  : undefined;
              if (entry.type === "message" && entry.message?.role === "assistant") {
                const promptTokens = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
                latestCacheHitRate = promptTokens > 0 ? ((u?.cacheRead ?? 0) / promptTokens) * 100 : undefined;
              }
              if (!u) continue;
              totalInput += u.input ?? 0;
              totalOutput += u.output ?? 0;
              totalCacheRead += u.cacheRead ?? 0;
              totalCacheWrite += u.cacheWrite ?? 0;
              totalCost += u.cost?.total ?? 0;
            }
            cached = { manager, sessionId, leafId, totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost, latestCacheHitRate };
          }
          const { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost, latestCacheHitRate } = cached;
          const model = ctx.model;
          const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;

          const statParts: string[] = [];
          if (totalInput) statParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statParts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) statParts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) statParts.push(`W${formatTokens(totalCacheWrite)}`);
          if (totalCost || usingSubscription) statParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

          if ((totalCacheRead || totalCacheWrite) && latestCacheHitRate !== undefined) statParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
          const branch = footerData.getGitBranch();
          if (branch) statParts.push(`(${sanitize(branch)})`);

          if (!contextCache || contextCache.totals !== cached || contextCache.model !== model) {
            contextCache = { totals: cached, model, usage: ctx.getContextUsage() };
          }
          const contextUsage = contextCache.usage;
          const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
          const pct = contextUsage?.percent ?? 0;
          const autoIndicator = (pi.getSettings().compaction?.enabled ?? true) ? " (auto)" : "";
          const ctxStr = (pct > 0 ? `${pct.toFixed(1)}%/${formatTokens(contextWindow)}` : `?/${formatTokens(contextWindow)}`) + autoIndicator;
          const styledCtx = pct > 90 ? theme.fg("error", ctxStr) : pct > 70 ? theme.fg("warning", ctxStr) : dim(ctxStr);
          const left = statParts.length > 0 ? dim(statParts.join(" ")) + " " + styledCtx : styledCtx;

          // Right: unconsumed extension statuses + subscription status
          const fg = (color: "dim" | "warning" | "error", s: string) => theme.fg(color, s);
          const subUsage = statuses.get("sub-status:usage");
          const showSubscriptionStatus = model?.provider === "claude-code"
            || (usingSubscription && (model?.provider === "openai" || model?.provider === "openai-codex" || model?.provider === "anthropic"));
          const subStr = !showSubscriptionStatus ? ""
            : subUsage ? formatSubscriptionStatus(subUsage, fg) : "";
          const consumedStatuses = new Set(["env", "sub-status:usage"]);
          const extensionStatuses = [...statuses.entries()]
            .filter(([key, value]) => !consumedStatuses.has(key) && sanitize(value).length > 0)
            .map(([, value]) => dim(sanitize(value)));
          const right = [...extensionStatuses, subStr].filter(Boolean).join(dim(" · "));

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);
          if (lw + rw + 1 <= width) return [left + " ".repeat(width - lw - rw) + right];
          const fittedLeft = truncateToWidth(left, width, dim("…"));
          return right ? [fittedLeft, truncateToWidth(right, width, dim("…"))] : [fittedLeft];
        },
      };
    });
  });
}

// ─── Custom settings ─────────────────────────────────────────────────────────

const CUSTOM_SETTINGS_PATH = join(getAgentDir(), "settings.json");

type TranscriptHistoryPanelControl = Pick<TranscriptHistoryControl, "getStatus" | "showOlder" | "showRecent" | "showFull">;

function registerTranscriptHistory(pi: ExtensionAPI): TranscriptHistoryPanelControl {
  let runtimeControl: TranscriptHistoryControl | undefined;
  let restoreDisplay: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    restoreDisplay?.();
    restoreDisplay = undefined;
    runtimeControl?.restore();
    runtimeControl = undefined;
    if (ctx.mode !== "tui") return;
    runtimeControl = installTranscriptHistory(
      InteractiveMode.prototype as unknown as Parameters<typeof installTranscriptHistory>[0],
    );
    restoreDisplay = installTranscriptDisplay(
      InteractiveMode.prototype as unknown as Parameters<typeof installTranscriptDisplay>[0],
      () => ctx.ui.theme,
    );
  });

  pi.on("session_compact", (event) => {
    runtimeControl?.omitCompactionOnNextRebuild(event.compactionEntry.id);
  });

  pi.on("session_shutdown", () => {
    restoreDisplay?.();
    restoreDisplay = undefined;
    runtimeControl?.restore();
    runtimeControl = undefined;
  });

  return {
    getStatus: () => runtimeControl?.getStatus() ?? "Recent",
    showOlder: () => runtimeControl?.showOlder(),
    showRecent: () => runtimeControl?.showRecent(),
    showFull: () => runtimeControl?.showFull(),
  };
}

type PreferencePanelItem = CustomSetting | "transcriptHistory";
type PreferencePanelGroup = "Codex" | "Transcript";

interface PreferencePanelRow {
  field: PreferencePanelItem;
  group: PreferencePanelGroup;
  label: string;
  description: string;
}

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

const PREFERENCE_ROWS: PreferencePanelRow[] = [
  {
    field: "fast",
    group: "Codex",
    label: "Fast mode",
    description: "Use OpenAI priority service tier with the openai-codex provider.",
  },
  {
    field: "transcriptOptimization",
    group: "Transcript",
    label: "Optimization",
    description: "Improve transcript rendering performance in long sessions.",
  },
  {
    field: "transcriptHistory",
    group: "Transcript",
    label: "History",
    description: "Show older conversation history without changing model context.",
  },
];

export class PreferencesPanel implements Component {
  private selected = 0;
  private readonly rows = PREFERENCE_ROWS;
  private readonly listTheme = getSettingsListTheme();
  private readonly topBorder = new DynamicBorder();
  private readonly bottomBorder = new DynamicBorder();

  constructor(
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly actions: PreferencesPanelActions,
    private readonly requestRender: () => void,
    private readonly close: () => void,
  ) {}

  private keyText(keybinding: "tui.select.confirm" | "tui.select.cancel" | "app.models.save"): string {
    return this.keybindings.getKeys(keybinding)
      .map((key) => key.split("+")
        .map((part) => process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part)
        .join("+"))
      .join("/");
  }

  private helpText(): string {
    const confirm = this.keyText("tui.select.confirm");
    const cancel = this.keyText("tui.select.cancel");
    return this.rows[this.selected]?.field === "transcriptHistory"
      ? `  ${confirm}/space load older · r recent · f full · ${cancel} cancel`
      : `  ${confirm}/space toggle · ${this.keyText("app.models.save")} save global · r reset · ${cancel} cancel`;
  }

  private formatScopedValue(value: string, scope: "global" | "session"): string {
    return `${value.padEnd(8)}${this.theme.fg("dim", `[${scope}]`)}`;
  }

  private currentValue(field: PreferencePanelItem): string {
    if (field === "transcriptHistory") return this.actions.getHistoryStatus();
    const setting = this.actions.get()[field];
    return this.formatScopedValue(setting.value ? "On" : "Off", setting.scope);
  }

  private renderBody(width: number): string[] {
    const lines: string[] = [];
    const labelWidth = Math.max(...this.rows.map((row) => visibleWidth(row.label)));
    let group: PreferencePanelGroup | undefined;

    for (const [index, row] of this.rows.entries()) {
      if (row.group !== group) {
        if (group) lines.push("");
        lines.push(`  ${this.theme.fg("accent", this.theme.bold(row.group))}`);
        group = row.group;
      }
      const isSelected = index === this.selected;
      const prefix = isSelected ? this.listTheme.cursor : "  ";
      const label = row.label.padEnd(labelWidth);
      const value = this.currentValue(row.field);
      lines.push(
        prefix
          + this.listTheme.label(label, isSelected)
          + "  "
          + this.listTheme.value(value, isSelected),
      );
    }

    const description = this.rows[this.selected]?.description;
    if (description) {
      lines.push("");
      for (const line of wrapTextWithAnsi(description, Math.max(1, width - 4))) {
        lines.push(this.listTheme.description(`  ${line}`));
      }
    }
    lines.push("", this.listTheme.hint(this.helpText()));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selected = (this.selected + this.rows.length - 1) % this.rows.length;
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.selected = (this.selected + 1) % this.rows.length;
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    } else {
      const field = this.rows[this.selected]!.field;
      if (field === "transcriptHistory") {
        if (data === " " || this.keybindings.matches(data, "tui.select.confirm")) this.actions.showOlderHistory();
        else if (data === "r") this.actions.showRecentHistory();
        else if (data === "f") this.actions.showFullHistory();
        else return;
      } else if (data === " " || this.keybindings.matches(data, "tui.select.confirm")) {
        this.actions.toggleSession(field);
      } else if (this.keybindings.matches(data, "app.models.save")) {
        this.actions.saveGlobal(field);
      } else if (data === "r") {
        this.actions.resetSession(field);
      } else {
        return;
      }
    }
    this.requestRender();
  }

  render(width: number): string[] {
    return [
      ...this.topBorder.render(width),
      ...this.renderBody(width),
      ...this.bottomBorder.render(width),
    ];
  }

  invalidate(): void {
    this.topBorder.invalidate();
    this.bottomBorder.invalidate();
  }
}

function registerCustomSettings(
  pi: ExtensionAPI,
  preferences: CustomPreferences,
  codexControl: CodexControl,
  transcriptHistory: TranscriptHistoryPanelControl,
): void {
  const summary = () => {
    // Mirrors the panel: its groups, labels, values and scopes.
    const settings = preferences.get();
    return PREFERENCE_ROWS.map((row) => {
      if (row.field === "transcriptHistory") return `${row.group} · ${row.label}: ${transcriptHistory.getStatus()}`;
      const setting = settings[row.field];
      const value = row.field === "fast" && codexControl.isDesired() && !codexControl.isActive()
        ? "Requested (openai-codex only)"
        : setting.value ? "On" : "Off";
      return `${row.group} · ${row.label}: ${value} [${setting.scope}]`;
    }).join("; ");
  };

  const toggleSession = (field: CustomSetting): void => {
    preferences.setSession(field, !preferences.get()[field].value);
  };

  const showPanel = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(summary(), "info");
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => new PreferencesPanel(
        theme,
        keybindings,
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
    handler: async (_args, ctx) => {
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

/** The `pi` on PATH, which an update points at the new install; the running one may have been removed. */
function piOnPath(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, "pi");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
}

function registerRestart(pi: ExtensionAPI): void {
  pi.registerCommand("restart", {
    description: "Restart pi, optionally sending a message after restart",
    handler: async (rawArgs, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/restart is only available in TUI mode", "error");
        return;
      }
      const continuation = rawArgs.trim();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const command = piOnPath();
      const args = command ? [command] : [process.execPath, process.argv[1]];
      if (sessionFile) args.push("--session", sessionFile);
      if (continuation) args.push(continuation);
      const execve = process.execve;
      process.once("exit", () => {
        try {
          execve?.(args[0], args, process.env as Record<string, string>);
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

export default async function piCustom(pi: ExtensionAPI) {
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
  const codexControl = registerCodex(pi, runtime, { fast: initial.fast.value });
  registerClaude(pi);
  registerClampedOutput(pi);
  const applyPreferences = () => {
    const settings = preferences.get();
    codexControl.setDesired(settings.fast.value);
    renderPerf.setEnabled(settings.transcriptOptimization.value);
  };
  preferences.onChange(applyPreferences);
  applyPreferences();

  registerRestart(pi);
  registerNotify(pi);
  registerUvGuard(pi);
  registerJjHint(pi);
  registerCustomSettings(pi, preferences, codexControl, transcriptHistory);
}
