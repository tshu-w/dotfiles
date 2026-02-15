/**
 * UV Guard Extension (compatible with ssh.ts)
 *
 * This version does NOT register/override the bash tool.
 * Instead, it intercepts bash tool calls and blocks common Python packaging
 * commands, nudging the agent toward uv equivalents.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Rule = {
  pattern: RegExp;
  title: string;
  suggestion: string;
};

const RULES: Rule[] = [
  {
    pattern: /(^|[;&|]\s*)(pip|pip3)\b/i,
    title: "pip/pip3 is blocked",
    suggestion:
      "Use uv instead:\n- uv add <pkg>\n- uv remove <pkg>\n- uv run --with <pkg> <command>",
  },
  {
    pattern: /(^|[;&|]\s*)poetry\b/i,
    title: "poetry is blocked",
    suggestion:
      "Use uv equivalents:\n- poetry init -> uv init\n- poetry add <pkg> -> uv add <pkg>\n- poetry install -> uv sync\n- poetry run <cmd> -> uv run <cmd>",
  },
  {
    pattern: /(^|[;&|]\s*)python3?\s+-m\s+pip\b/i,
    title: "python -m pip is blocked",
    suggestion: "Use uv add / uv run --with instead of pip.",
  },
  {
    pattern: /(^|[;&|]\s*)python3?\s+-m\s+venv\b/i,
    title: "python -m venv is blocked",
    suggestion: "Use uv venv (or just uv run / uv sync when possible).",
  },
];

function findRule(command: string): Rule | undefined {
  return RULES.find((rule) => rule.pattern.test(command));
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("UV guard loaded (bash tool not overridden)", "info");
  });

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
