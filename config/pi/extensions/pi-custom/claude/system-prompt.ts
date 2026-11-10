import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai";

// Pi's default docs guide and identity, matched by shape so wording from any Pi version is recognized.
// Anthropic bills requests carrying this guide as a third-party app, outside the subscription.
const DEFAULT_DOCS = /^<docs>\nPi documentation \([^\n]*\):\n(?:- [^\n]*\n)+<\/docs>$/;
// The default identity is two sentences on one line; a prompt that adds anything is custom and stays.
const DEFAULT_PREAMBLE = /^You are [^\n]* inside pi, a coding agent harness\. (?:You help|Help) users [^.\n]*\.$/;

function isPiDefaultSection(name: string, value: string | null): boolean {
  return value !== null && (name === "docs" ? DEFAULT_DOCS : name === "preamble" ? DEFAULT_PREAMBLE : undefined)?.test(value) === true;
}

// Each default section is dropped on its own, in the prompt and in later system patches alike.
export function withoutPiDefaults<T extends string | null>(sections: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(sections).filter(([name, value]) => !isPiDefaultSection(name, value)));
}

function rewriteToolReferences(text: string, names: Map<string, string>): string {
  for (const [mcpName, piName] of names) {
    const name = piName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text
      .replace(new RegExp(`^(- )${name}(?=:)`, "gm"), `$1${mcpName}`)
      .replaceAll(`\`${piName}\``, `\`${mcpName}\``)
      .replace(new RegExp(`(?<![\\w./-])${name}(?=\\()`, "g"), mcpName)
      .replace(new RegExp(`\\b(Use (?:the )?)${name}(?![\\w./-])`, "g"), `$1${mcpName}`)
      .replace(new RegExp(`(?<![\\w./-])${name}(?= tool\\b)`, "g"), mcpName);
  }
  return text;
}

export async function buildClaudeSystemPrompt(message: SystemMessage | undefined, names: Map<string, string>): Promise<Options["systemPrompt"]> {
  // Forced prompts and auxiliary requests are opaque, exact replacements.
  if (!message?.sections) return message ? getSystemMessageText(message) : "";
  const sections = withoutPiDefaults(message.sections);
  for (const name of ["tools", "rules", "skills"]) {
    if (sections[name]) sections[name] = rewriteToolReferences(sections[name], names);
  }
  const guidance = names.size
    ? "Use only the tools exposed for this request. Claude Code's built-in tools are disabled. Short tool names in the following instructions refer to their mcp__pi__<name> counterparts."
    : "No tools are available for this request.";
  const append = getSystemMessageText({ ...message, sections });
  return { type: "preset", preset: "claude_code", append: `${guidance}\n\n${append}` };
}
