import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai";
import { rewriteToolReferences } from "../tool-references.js";

// Pi's default docs guide and identity, matched by shape so wording from any Pi version is recognized.
// Anthropic bills requests carrying this guide as a third-party app, outside the subscription.
const DEFAULT_DOCS = /^<docs>\nPi documentation \([^\n]*\):\n(?:- [^\n]*\n)+<\/docs>$/;
// The default identity is two sentences on one line; a prompt that adds anything is custom and stays.
const DEFAULT_PREAMBLE = /^You are [^\n]* inside pi, a coding agent harness\. (?:You help|Help) users [^.\n]*\.$/;

function isPiDefaultSection(name: string, value: string | null): boolean {
  const pattern = name === "docs" ? DEFAULT_DOCS : name === "preamble" ? DEFAULT_PREAMBLE : undefined;
  // Removing one of these sections leaves nothing to tell: the default was never shown.
  return pattern !== undefined && (value === null || pattern.test(value));
}

// Each default section is dropped on its own, in the prompt and in later system patches alike.
export function withoutPiDefaults<T extends string | null>(sections: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(sections).filter(([name, value]) => !isPiDefaultSection(name, value)));
}

export async function buildClaudeSystemPrompt(message: SystemMessage | undefined, names: Map<string, string>): Promise<Options["systemPrompt"]> {
  // Forced prompts and auxiliary requests are opaque, exact replacements.
  if (!message?.sections) return message ? getSystemMessageText(message) : "";
  const sections = withoutPiDefaults(message.sections);
  for (const name of ["tools", "rules", "skills"]) {
    if (sections[name]) sections[name] = rewriteToolReferences(sections[name], names);
  }
  const guidance = names.size
    ? "Use only the Pi tools exposed through MCP. Short tool names in the following instructions refer to their mcp__pi__<name> counterparts."
    : "No tools are available for this request.";
  const append = getSystemMessageText({ ...message, sections });
  return { type: "preset", preset: "claude_code", append: `${guidance}\n\n${append}` };
}
