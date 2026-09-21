import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai";
import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";

const DEFAULT_PREAMBLE = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

// Match the complete native section: custom overrides and additions must survive.
function defaultDocs(): string {
  return `<docs>
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)
</docs>`;
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

export function buildClaudeSystemPrompt(message: SystemMessage | undefined, names: Map<string, string>): Options["systemPrompt"] {
  // Forced prompts and auxiliary requests are opaque, exact replacements.
  if (!message?.sections) return message ? getSystemMessageText(message) : "";
  const sections = { ...message.sections };
  if (sections.preamble === DEFAULT_PREAMBLE) delete sections.preamble;
  if (sections.docs === defaultDocs()) delete sections.docs;
  for (const name of ["tools", "rules", "skills"]) {
    if (sections[name]) sections[name] = rewriteToolReferences(sections[name], names);
  }
  const guidance = names.size
    ? "Use only the tools exposed for this request. Claude Code's built-in tools are disabled. Short tool names in the following instructions refer to their mcp__pi__<name> counterparts."
    : "No tools are available for this request.";
  const append = getSystemMessageText({ ...message, sections });
  return { type: "preset", preset: "claude_code", append: `${guidance}\n\n${append}` };
}
