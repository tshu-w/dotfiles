import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ─── Shell parser ─────────────────────────────────────────────────────────────

function splitShellSegments(input: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let heredocDelim: string | null = null;

  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed) segments.push(trimmed);
    buf = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) { buf += ch; escaped = false; continue; }
    if (ch === "\\") { escaped = true; buf += ch; continue; }
    if (quote) { if (ch === quote) quote = null; buf += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "<" && input[i + 1] === "<" && input[i + 2] !== "<") {
      let j = i + 2;
      if (j < input.length && input[j] === "-") j++;
      while (j < input.length && input[j] === " ") j++;
      let delim = "";
      if (j < input.length && (input[j] === "'" || input[j] === '"')) {
        const q = input[j++];
        while (j < input.length && input[j] !== q) delim += input[j++];
        if (j < input.length) j++;
      } else {
        while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) delim += input[j++];
      }
      if (delim) { heredocDelim = delim; buf += input.slice(i, j); i = j - 1; continue; }
    }
    if (ch === "\n") {
      flush();
      if (heredocDelim !== null) {
        const delim = heredocDelim;
        heredocDelim = null;
        i++;
        while (i < input.length) {
          const lineEnd = input.indexOf("\n", i);
          const line = lineEnd === -1 ? input.slice(i) : input.slice(i, lineEnd);
          if (line.trim() === delim) { i = lineEnd === -1 ? input.length - 1 : lineEnd; break; }
          i = lineEnd === -1 ? input.length : lineEnd + 1;
        }
      }
      continue;
    }
    if (ch === ";") { flush(); continue; }
    if ((ch === "&" || ch === "|") && input[i + 1] === ch) { flush(); i++; continue; }
    buf += ch;
  }
  flush();
  return segments;
}

function splitShellWords(segment: string): string[] {
  const words: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = () => { if (buf.length > 0) { words.push(buf); buf = ""; } };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (escaped) { buf += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; else buf += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    buf += ch;
  }
  flush();
  return words;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function getCommand(segment: string): string | undefined {
  const words = splitShellWords(segment);
  let i = 0;
  while (i < words.length && isEnvAssignment(words[i])) i++;
  return i < words.length ? words[i].toLowerCase() : undefined;
}

function getInvocation(segment: string): { cmd: string; args: string[] } | undefined {
  const words = splitShellWords(segment);
  let i = 0;
  while (i < words.length && isEnvAssignment(words[i])) i++;
  if (i >= words.length) return undefined;
  return { cmd: words[i].toLowerCase(), args: words.slice(i + 1) };
}

// ─── UV Guard ─────────────────────────────────────────────────────────────────

const PIP_SUGGESTION = [
  "Use uv instead:",
  "",
  "  To install a package for a script: uv run --with PACKAGE python script.py",
  "  To add a dependency to the project: uv add PACKAGE",
].join("\n");

const POETRY_SUGGESTION = "Use uv instead of poetry (uv init, uv add, uv sync, uv run)";

function pythonRule(
  cmd: "python" | "python3",
  args: string[],
): { title: string; suggestion: string } {
  const lower = args.map((a) => a.toLowerCase());
  const hasPip = lower.some((a) => a === "pip" || a === "-mpip");
  const hasVenv = lower.some((a) => a === "venv" || a === "-mvenv");
  if (hasPip) return { title: `${cmd} -m pip is blocked`, suggestion: PIP_SUGGESTION };
  if (hasVenv) return {
    title: `${cmd} -m venv is blocked`,
    suggestion: "Use uv instead:\n\n  To create a virtual environment: uv venv",
  };
  return { title: `${cmd} should be run via uv`, suggestion: "Use: uv run python <args>" };
}

function findUvRule(command: string): { title: string; suggestion: string } | undefined {
  for (const segment of splitShellSegments(command)) {
    const inv = getInvocation(segment);
    if (!inv) continue;
    if (inv.cmd === "pip" || inv.cmd === "pip3") return { title: "pip is blocked", suggestion: PIP_SUGGESTION };
    if (inv.cmd === "poetry") return { title: "poetry is blocked", suggestion: POETRY_SUGGESTION };
    if (inv.cmd === "python" || inv.cmd === "python3") return pythonRule(inv.cmd, inv.args);
  }
  return undefined;
}

export function registerUvGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: string })?.command ?? "");
    if (!command.trim()) return;
    const rule = findUvRule(command);
    if (!rule) return;
    if (ctx.hasUI) ctx.ui.notify(`${rule.title}. ${rule.suggestion}`, "warning");
    return { block: true, reason: `${rule.title}. ${rule.suggestion}` };
  });
}

// ─── JJ Guard ─────────────────────────────────────────────────────────────────

let jjInstalled: boolean | undefined;

function isJjInstalled(): boolean {
  if (jjInstalled !== undefined) return jjInstalled;
  try {
    execSync("command -v jj", { stdio: "ignore" });
    jjInstalled = true;
  } catch {
    jjInstalled = false;
  }
  return jjInstalled;
}

const jjRepoCache = new Map<string, boolean>();
const gitRepoCache = new Map<string, boolean>();

function walkUpFor(cwd: string, marker: string, cache: Map<string, boolean>): boolean {
  const start = resolve(cwd);
  const cached = cache.get(start);
  if (cached !== undefined) return cached;
  let dir = start;
  while (true) {
    if (existsSync(`${dir}/${marker}`)) { cache.set(start, true); return true; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(start, false);
  return false;
}

function colocatePrelude(cwd: string): string {
  if (walkUpFor(cwd, ".git", gitRepoCache) && !walkUpFor(cwd, ".jj", jjRepoCache)) {
    return "This repo is not yet a jj repo. Adopt jj first:\n  jj git init --colocate\n\nThen:\n";
  }
  return "";
}

function invokesGit(command: string): boolean {
  return splitShellSegments(command).some((seg) => getCommand(seg) === "git");
}

export function registerJjGuard(pi: ExtensionAPI): void {
  if (!isJjInstalled()) return;

  let warned = false;
  pi.on("session_start", () => { warned = false; });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: string })?.command ?? "");
    if (!command.trim() || !invokesGit(command)) return;
    const prelude = colocatePrelude(ctx.cwd);
    const message = `Prefer \`jj\` over \`git\`.\n\n${prelude}\`jj\` is installed — use it instead of \`git\`. Run \`jj --help\` for available commands.`;
    if (ctx.hasUI && !warned) { warned = true; ctx.ui.notify(message, "warning"); }
  });
}
