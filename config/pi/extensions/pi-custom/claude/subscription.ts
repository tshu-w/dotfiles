import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

export const USAGE_CREDITS_ERROR = "Claude Code billing: this provider only allows subscription usage. Some requests may already have been charged. Check claude.ai/settings/usage and ensure usage credits are disabled, then reload Pi before retrying.";

export function normalizeClaudeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(USAGE_CREDITS_ERROR) || message.startsWith("Claude Code quota exceeded") || message.startsWith("context_length_exceeded:")) return message;
  if (/third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/i.test(message)) {
    return `${USAGE_CREDITS_ERROR} Original error: ${message}`;
  }
  if (/(?:^|\n)you've (?:hit|reached) your (?:(?:(?:session|5-hour|weekly|opus|sonnet|fable|usage(?: credit)?|(?:(?:org|channel)'s )?monthly (?:spend|usage)) )?limit|team's shared budget)\b/i.test(message)
    || /(?:^|\n)(?:you're out of usage credits|your org is out of usage|your seat type doesn't include (?:usage(?: credits)?|extra usage))\b/i.test(message)
    || /(?:^|\n)(?:your usage allocation has been disabled by your admin|your group's usage limit is set to \$0|this service is disabled for your org)\b/i.test(message)) {
    return `Claude Code quota exceeded: ${message}`;
  }
  if (/prompt is too long|context(?:_| )length|context window exceeded|too many input tokens/i.test(message)) {
    return `context_length_exceeded: ${message}`;
  }
  return message;
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
