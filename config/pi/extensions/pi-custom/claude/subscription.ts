import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export const USAGE_CREDITS_ERROR = "Claude Code billing: this provider only allows subscription usage. Some requests may already have been charged. Check claude.ai/settings/usage and ensure usage credits are disabled, then reload Pi before retrying.";

/** A turn the model ended on purpose, such as a refusal; retrying the same request does not help. */
export class ClaudeStop extends Error {}

export function normalizeClaudeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(USAGE_CREDITS_ERROR) || message.startsWith("Claude Code quota exceeded") || message.startsWith("context_length_exceeded:")) return message;
  if (/third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/i.test(message)) {
    return `${USAGE_CREDITS_ERROR} Original error: ${message}`;
  }
  // Organization policy refusals share the rate_limit type but, unlike a reached limit, carry no rejected rate-limit event.
  if (/(?:^|\n)(?:your usage allocation has been disabled by your admin|your group's usage limit is set to \$0|this service is disabled for your org|your seat type doesn't include (?:usage(?: credits)?|extra usage))\b/i.test(message)) {
    return `Claude Code quota exceeded: ${message}`;
  }
  if (/prompt is too long|context(?:_| )length|context window exceeded|too many input tokens/i.test(message)) {
    return `context_length_exceeded: ${message}`;
  }
  return message;
}

/** Pi retries by wording, so name a typed error by its class: a reached limit (the latest rate-limit event
 *  was rejected) as an exceeded quota, and an unknown error as a server error. The other types either
 *  match Pi's transient patterns (server_error, overloaded, rate_limit) or no pattern at all. */
export function typedClaudeError(type: string, detail: string, limitRejected: boolean): string {
  const message = `Claude Code: ${type === "unknown" ? "server_error (unknown)" : type}${detail ? `\n${detail}` : ""}`;
  return type === "rate_limit" && limitRejected ? `Claude Code quota exceeded: ${message}` : message;
}

/** A running query's failure that is neither named (a typed error or a stream the bridge cannot convert)
 *  nor a quota, billing or context error is transient: a dropped connection, a process exit or an incomplete stream. */
export function queryError(error: unknown): string {
  if (error instanceof ClaudeStop) return error.message;
  const message = normalizeClaudeError(error);
  return /^(?:Claude Code(?:: | billing| quota exceeded)|context_length_exceeded:)/.test(message) ? message : `Claude Code: server_error\n${message}`;
}

export function subscriptionEnvironment(request: SimpleStreamOptions) {
  const env = { ...process.env, ...request.env };
  delete env.ANTHROPIC_API_KEY;
  const conflicts = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY"]
    .filter((name) => env[name]);
  for (const backend of ["BEDROCK", "VERTEX", "FOUNDRY", "ANTHROPIC_AWS", "ANTHROPIC_GOOGLE_CLOUD", "MANTLE", "GATEWAY"]) {
    const name = `CLAUDE_CODE_USE_${backend}`;
    if (/^(1|true|yes|on)$/i.test(env[name] ?? "")) conflicts.push(name);
  }
  const headers = Object.entries(request.headers ?? {}).filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}: ${value}`).join("\n");
  for (const value of [env.ANTHROPIC_CUSTOM_HEADERS, headers]) {
    if (/^\s*(authorization|proxy-authorization|x-api-key)\s*:/im.test(value ?? "")) {
      conflicts.push("ANTHROPIC_CUSTOM_HEADERS/request.headers authentication");
      break;
    }
  }
  if (conflicts.length) {
    throw new Error(`Claude Code billing: subscription-only provider refuses auth/backend overrides: ${conflicts.join(", ")}. Remove these overrides and use Claude Code subscription login.`);
  }
  if (headers) env.ANTHROPIC_CUSTOM_HEADERS = headers;
  return env;
}
