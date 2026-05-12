/**
 * jj Guard Extension (compatible with ssh.ts, parallel to uv.ts)
 *
 * Policy: if `jj` is installed on this machine, all direct `git`
 * invocations are blocked. The agent must use `jj` for every VCS
 * operation — including read-only inspection and network ops, for
 * which jj has natural equivalents (`jj st`, `jj log`, `jj git fetch`,
 * `jj git push`, etc.).
 *
 * Rationale for blanket block:
 * - "`jj` installed = `jj` is the policy" mirrors uv-vs-pip. No per-
 *   subcommand carve-outs to keep in sync with a moving target.
 * - `jj st`/`jj log`/`jj diff` surface jj-native state (change IDs,
 *   DAG, conflict markers) that `git` equivalents hide.
 * - Keeps this extension trivial: no shell-subcommand classifier, no
 *   flag heuristics, no false negatives on `git -C dir <mutate>`.
 *
 * If `jj` is not installed, this extension is a no-op forever.
 *
 * Decisions about *which* jj command to run, and with which flags,
 * stay with the agent; see skills/jj/SKILL.md. The agent is expected
 * to consult `jj <cmd> --help` for exact syntax.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// jj availability + per-cwd repo detection (small caches)
// ---------------------------------------------------------------------------

let jjInstalledCached: boolean | undefined;

function isJjInstalled(): boolean {
  if (jjInstalledCached !== undefined) return jjInstalledCached;
  try {
    execSync("command -v jj", { stdio: "ignore" });
    jjInstalledCached = true;
  } catch {
    jjInstalledCached = false;
  }
  return jjInstalledCached;
}

const jjRepoCache = new Map<string, boolean>();
const gitRepoCache = new Map<string, boolean>();

function walkUpFor(cwd: string, marker: string, cache: Map<string, boolean>): boolean {
  const start = resolve(cwd);
  const cached = cache.get(start);
  if (cached !== undefined) return cached;
  let dir = start;
  while (true) {
    if (existsSync(`${dir}/${marker}`)) {
      cache.set(start, true);
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(start, false);
  return false;
}

const isInsideJjRepo = (cwd: string) => walkUpFor(cwd, ".jj", jjRepoCache);
const isInsideGitRepo = (cwd: string) => walkUpFor(cwd, ".git", gitRepoCache);

function colocatePrelude(cwd: string): string {
  if (isInsideGitRepo(cwd) && !isInsideJjRepo(cwd)) {
    return "This repo is not yet a jj repo. Adopt jj first:\n  jj git init --colocate\n\nThen:\n";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Shell parsing (same approach as uv.ts: segment-level + word-level)
// ---------------------------------------------------------------------------

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
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      buf += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "<" && input[i + 1] === "<" && input[i + 2] !== "<") {
      let j = i + 2;
      if (j < input.length && input[j] === "-") j++;
      while (j < input.length && input[j] === " ") j++;
      let delim = "";
      if (j < input.length && (input[j] === "'" || input[j] === '"')) {
        const q = input[j];
        j++;
        while (j < input.length && input[j] !== q) {
          delim += input[j];
          j++;
        }
        if (j < input.length) j++;
      } else {
        while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) {
          delim += input[j];
          j++;
        }
      }
      if (delim) {
        heredocDelim = delim;
        buf += input.slice(i, j);
        i = j - 1;
        continue;
      }
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
          if (line.trim() === delim) {
            i = lineEnd === -1 ? input.length - 1 : lineEnd;
            break;
          }
          i = lineEnd === -1 ? input.length : lineEnd + 1;
        }
      }
      continue;
    }
    if (ch === ";") {
      flush();
      continue;
    }
    if ((ch === "&" || ch === "|") && input[i + 1] === ch) {
      flush();
      i++;
      continue;
    }
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
  const flush = () => {
    if (buf.length > 0) {
      words.push(buf);
      buf = "";
    }
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return words;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

// Returns the command name (first non-env-assignment word), lowercased.
function getCommand(segment: string): string | undefined {
  const words = splitShellWords(segment);
  if (!words.length) return undefined;
  let i = 0;
  while (i < words.length && isEnvAssignment(words[i])) i++;
  if (i >= words.length) return undefined;
  return words[i].toLowerCase();
}

// ---------------------------------------------------------------------------
// Policy: block any invocation whose command is `git`.
// Note: `git-lfs`, `github`, etc. are different commands and unaffected.
// ---------------------------------------------------------------------------

function invokesGit(command: string): boolean {
  for (const segment of splitShellSegments(command)) {
    if (getCommand(segment) === "git") return true;
  }
  return false;
}

const SUGGESTION = [
  "This machine has `jj` installed; use it for all VCS operations.",
  "",
  "Common equivalents (run `jj <cmd> --help` for exact flags):",
  "  inspect:   jj st  /  jj log  /  jj diff  /  jj show",
  "  commit:    jj describe + jj new   (or `jj commit`)",
  "  stash:     jj new @-              (old WC stays as sibling)",
  "  switch:    jj new <ref>  /  jj edit <change>",
  "  rewrite:   jj edit / jj squash / jj split / jj absorb / jj rebase / jj arrange",
  "  undo:      jj undo                (or `jj op log` + `jj op restore <id>`)",
  "  discard:   jj restore <paths>     (WC edits)   /   jj abandon <change>",
  "  branch:    jj bookmark <set|delete|rename|list>",
  "  remote:    jj git fetch  /  jj git push --bookmark <name>  /  jj git clone <url>",
  "",
  "If `jj` truly has no equivalent (e.g. `git tag` for annotated tags),",
  "bypass explicitly with `command git ...` to make the exception visible.",
  "",
  "Background: `jj help -k tutorial`.",
].join("\n");

// ---------------------------------------------------------------------------
// Tool-call hook
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  if (!isJjInstalled()) return;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String((event.input as { command?: string })?.command ?? "");
    if (!command.trim()) return;
    if (!invokesGit(command)) return;

    const prelude = colocatePrelude(process.cwd());
    const message = `\`git\` is blocked — use \`jj\` instead.\n\n${prelude}${SUGGESTION}`;

    if (ctx.hasUI) {
      ctx.ui.notify(message, "warning");
    }

    return {
      block: true,
      reason: message,
    };
  });
}
