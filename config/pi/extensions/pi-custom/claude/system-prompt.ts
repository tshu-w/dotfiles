import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

const DEFAULT_PREAMBLE = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

// Pi does not publicly export this builder; integration tests track its internal API.
async function defaultDocs(): Promise<string> {
  const { buildSystemPromptSections } = await import(pathToFileURL(join(getPackageDir(), "dist/core/system-prompt.js")).href);
  return buildSystemPromptSections({ cwd: "" }).docs;
}

function normalizeDocsInstallPaths(text: string): string {
  return text.replace(
    /^(- (?:Main documentation|Additional docs|Examples): )\S+?(?=\/@earendil-works\/pi-coding-agent\/)/gm,
    "$1<install>",
  );
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
  const sections = { ...message.sections };
  if (sections.preamble === DEFAULT_PREAMBLE) delete sections.preamble;
  if (sections.docs && normalizeDocsInstallPaths(sections.docs) === normalizeDocsInstallPaths(await defaultDocs())) delete sections.docs;
  for (const name of ["tools", "rules", "skills"]) {
    if (sections[name]) sections[name] = rewriteToolReferences(sections[name], names);
  }
  const guidance = names.size
    ? "Use only the tools exposed for this request. Claude Code's built-in tools are disabled. Short tool names in the following instructions refer to their mcp__pi__<name> counterparts."
    : "No tools are available for this request.";
  const append = getSystemMessageText({ ...message, sections });
  return { type: "preset", preset: "claude_code", append: `${guidance}\n\n${append}` };
}
