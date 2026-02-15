/**
 * UV Guard Extension (compatible with ssh.ts)
 *
 * Does NOT override/register the bash tool.
 * Instead, it blocks disallowed commands and asks the agent to use uv
 * equivalents, aligned with the intercepted-commands behavior from:
 * https://github.com/mitsuhiko/agent-stuff/tree/main/intercepted-commands
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type RuleMatch = {
  title: string;
  suggestion: string;
};

const PIP_SUGGESTION = [
  "Use uv instead:",
  "",
  "  To install a package for a script: uv run --with PACKAGE python script.py",
  "  To add a dependency to the project: uv add PACKAGE",
].join("\n");

const POETRY_SUGGESTION = "Use uv instead of poetry (uv init, uv add, uv sync, uv run)";

function splitShellSegments(input: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

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

    if (ch === ";" || ch === "\n") {
      flush();
      continue;
    }

    if ((ch === "&" || ch === "|") && input[i + 1] === ch) {
      flush();
      i++; // skip second & or |
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

function getInvocation(segment: string): { cmd: string; args: string[] } | undefined {
  const words = splitShellWords(segment);
  if (!words.length) return undefined;

  let i = 0;
  while (i < words.length && isEnvAssignment(words[i])) i++;
  if (i >= words.length) return undefined;

  return {
    cmd: words[i].toLowerCase(),
    args: words.slice(i + 1),
  };
}

function pythonRule(cmd: "python" | "python3", args: string[]): RuleMatch {
  const lowerArgs = args.map((arg) => arg.toLowerCase());

  const hasPip =
    lowerArgs.includes("pip") ||
    lowerArgs.includes("-mpip") ||
    lowerArgs.some((arg, idx) => arg === "pip" && lowerArgs[idx - 1] === "-m");

  if (hasPip) {
    return {
      title: `${cmd} -m pip is blocked`,
      suggestion: [
        "Use uv instead:",
        "",
        "  To install a package for a script: uv run --with PACKAGE python script.py",
        "  To add a dependency to the project: uv add PACKAGE",
      ].join("\n"),
    };
  }

  const hasVenv =
    lowerArgs.includes("venv") ||
    lowerArgs.includes("-mvenv") ||
    lowerArgs.some((arg, idx) => arg === "venv" && lowerArgs[idx - 1] === "-m");

  if (hasVenv) {
    return {
      title: `${cmd} -m venv is blocked`,
      suggestion: ["Use uv instead:", "", "  To create a virtual environment: uv venv"].join("\n"),
    };
  }

  // In intercepted-commands this is transparently rewritten to `uv run python`.
  // Since this extension cannot override bash (ssh.ts compatibility), we block
  // and require the explicit uv form.
  return {
    title: `${cmd} should be run via uv`,
    suggestion: `Use: uv run python <args>`,
  };
}

function findRule(command: string): RuleMatch | undefined {
  const segments = splitShellSegments(command);

  for (const segment of segments) {
    const invocation = getInvocation(segment);
    if (!invocation) continue;

    if (invocation.cmd === "pip") {
      return { title: "pip is blocked", suggestion: PIP_SUGGESTION };
    }

    if (invocation.cmd === "pip3") {
      return { title: "pip3 is blocked", suggestion: PIP_SUGGESTION };
    }

    if (invocation.cmd === "poetry") {
      return { title: "poetry is blocked", suggestion: POETRY_SUGGESTION };
    }

    if (invocation.cmd === "python" || invocation.cmd === "python3") {
      return pythonRule(invocation.cmd, invocation.args);
    }
  }

  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String((event.input as { command?: string })?.command ?? "");
    if (!command.trim()) return;

    const rule = findRule(command);
    if (!rule) return;

    if (ctx.hasUI) {
      ctx.ui.notify(`${rule.title}. ${rule.suggestion}`, "warning");
    }

    return {
      block: true,
      reason: `${rule.title}. ${rule.suggestion}`,
    };
  });
}
