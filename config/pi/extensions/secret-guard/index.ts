/**
 * Secret Guard — practical guard against LLM accessing sensitive files and leaking secrets.
 *
 * Three layers, all via events (no registerTool, no conflict with SSH/Sandbox):
 *   1. tool_call: block read/write/edit/bash on credential files
 *   2. tool_result: always scrub high-confidence secret shapes
 *   3. tool_result: scrub env assignments and generic secret fields only for config-like file reads
 *
 * Scope: LLM tool calls only. User `!` commands are not intercepted.
 * This is a practical guard, not a complete DLP solution.
 */

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
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

function matchedPath(p: string) {
  const norm = p.toLowerCase().replace(/\\/g, "/");
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
      const hit = matchedPath(event.input.command);
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
      return { content: [...content, { type: "text" as const, text: REDACTION_NOTICE }] };
    }
  });
}
