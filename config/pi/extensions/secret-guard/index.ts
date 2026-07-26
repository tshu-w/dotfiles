/**
 * Secret Guard — practical guard against LLM accessing sensitive files and leaking secrets.
 *
 * Three layers, all via events (no registerTool, no conflict with SSH/Sandbox):
 *   1. tool_call: block read/write/edit and normalized shell references to credential files
 *   2. tool_result: always scrub high-confidence secret shapes, including scoped OpenAI tokens
 *   3. tool_result: scrub env assignments and generic secret fields only for config-like file reads
 *
 * Scope: LLM tool calls only. User `!` commands are not intercepted.
 * This is a practical guard, not a complete DLP solution.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, isToolCallEventType, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isConfigLikePath, scrubOutput } from "./redact.js";

// Credential files — read/write/edit/bash all blocked
const REDACTION_NOTICE = "[Secret Guard redacted sensitive values from this tool output. Do not copy [REDACTED] placeholders back into files.]";

const BLOCKED_PATHS = [
  ".authinfo.gpg",
  ".authinfo",
  ".netrc",
  ".gnupg/",
  ".ssh/id_",
  ".aws/credentials",
  ".config/gh/hosts.yml",
  ".docker/config.json",
  ".vault-token",
  ".password-store/",
  ".config/git/credentials",
  ".git-credentials",
];

function utf8Prefix(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function boundRedactedText(value: string): string {
  const notice = `\n${REDACTION_NOTICE}`;
  const full = truncateHead(value + notice, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!full.truncated) return value;

  const budget = DEFAULT_MAX_BYTES - Buffer.byteLength(notice);
  const preview = truncateHead(value, { maxBytes: budget, maxLines: DEFAULT_MAX_LINES - 1 });
  const content = preview.content || utf8Prefix(value.split("\n")[0] ?? "", budget);
  return content;
}

function matchedPath(p: string, shellCommand = false) {
  let norm = p.toLowerCase();
  if (shellCommand) {
    norm = norm.replace(/\\\r?\n/g, "").replace(/\\(.)/gs, "$1").replace(/\$?['"]/g, "");
  } else {
    norm = norm.replace(/\\/g, "/");
  }
  return BLOCKED_PATHS.find((pat) => norm.includes(pat));
}

export default function (pi: ExtensionAPI) {
  // Layer 1: block file access and bash references to credential paths
  pi.on("tool_call", async (event, ctx) => {
    const path = (event.input as { path?: string }).path;

    if (["read", "write", "edit"].includes(event.toolName) && path) {
      const hit = matchedPath(path);
      if (hit) {
        if (ctx.hasUI) ctx.ui.notify(`Blocked ${event.toolName}: ${path}`, "warning");
        return { block: true, reason: `Sensitive file (${hit})` };
      }
    }

    if (isToolCallEventType("bash", event)) {
      const hit = matchedPath(event.input.command, true);
      if (hit) {
        if (ctx.hasUI) ctx.ui.notify("Blocked bash: sensitive file reference", "warning");
        return { block: true, reason: `Sensitive path in command (${hit})` };
      }
    }
  });

  // Layer 2+3: keep source code intact while applying stronger field heuristics to config files.
  pi.on("tool_result", async (event) => {
    if (!event.content) return;

    const path = event.toolName === "read" ? (event.input as { path?: string }).path : undefined;
    const configLikeRead = isConfigLikePath(path);
    const options = {
      envAssignments: event.toolName !== "read" || configLikeRead,
      genericFields: configLikeRead,
    };

    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const scrubbed = scrubOutput(part.text, options);
      if (scrubbed !== part.text) changed = true;
      return { ...part, text: scrubbed };
    });

    if (changed) {
      const text = content
        .map((part) => part.type === "text" ? part.text : "")
        .filter(Boolean)
        .join("\n");
      const completeText = `${text}\n${REDACTION_NOTICE}`;
      const complete = truncateHead(completeText, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      if (!complete.truncated) {
        return { content: [...content, { type: "text" as const, text: REDACTION_NOTICE }] };
      }

      const bounded = boundRedactedText(text);
      const result = content.filter((part) => part.type !== "text") as typeof content;
      if (bounded) result.unshift({ type: "text" as const, text: bounded });
      result.push({ type: "text" as const, text: REDACTION_NOTICE });
      return { content: result };
    }
  });
}
