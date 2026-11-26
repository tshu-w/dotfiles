import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai";
import { rewriteToolReferences } from "../tool-references.js";
import { withoutPiDefaults } from "../system-prompt.js";

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
