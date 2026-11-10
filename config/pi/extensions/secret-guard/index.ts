/**
 * Secret Guard blocks model tool access to credential files and redacts secrets from tool output.
 *
 * User `!` commands are not intercepted.
 */

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isConfigLikePath, scrubOutput } from "./redact.js";

const REDACTION_NOTICE = "[Secret Guard redacted sensitive values. Do not copy [REDACTED] back into files.]";

// Credential files: read, write, edit, grep, and bash are all blocked.
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
  // Block file tools and bash commands that reference credential paths.
  pi.on("tool_call", async (event) => {
    const path = (event.input as { path?: string }).path;

    if (["read", "write", "edit", "grep"].includes(event.toolName) && path) {
      const hit = matchedPath(path);
      if (hit) {
        return { block: true, reason: `Sensitive file (${hit})` };
      }
    }

    if (isToolCallEventType("bash", event)) {
      const hit = matchedPath(event.input.command, true);
      if (hit) {
        return { block: true, reason: `Sensitive path in command (${hit})` };
      }
    }
  });

  // Redact secrets from tool output: keep source code intact and apply stronger field heuristics to config files.
  pi.on("tool_result", async (event) => {
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

    const containsSecret = (value: unknown): boolean => {
      if (typeof value === "string") return scrubOutput(value, options) !== value;
      if (!value || typeof value !== "object") return false;
      return Object.values(value).some(containsSecret);
    };
    const structured = event.structuredContent;
    const serialized = structured !== undefined && configLikeRead ? JSON.stringify(structured) : "";
    if (!changed && !containsSecret(structured) && scrubOutput(serialized, options) === serialized) return;

    // Returning content without structuredContent makes Pi drop the unsafe structured
    // result. Scan raw strings too: JSON escaping hides multiline private-key blocks.
    // The notice follows the tool's own output, including any truncation footer it
    // appended. Built-in tools bound their body and add notices on top of it.
    return { content: [...content, { type: "text" as const, text: REDACTION_NOTICE }] };
  });
}
