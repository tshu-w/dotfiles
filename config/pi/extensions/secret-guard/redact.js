// Env var name suffixes whose values get redacted (case-insensitive)
const ENV_SUFFIX_RE = /\b(\w*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)=)("[^"]*"|'[^']*'|[^\s\n#"']+)/gi;

// Known token prefix patterns — redact the whole token
const TOKEN_PREFIX_RE = /\b(sk-ant-api\d{2}-[\w-]{80,}|sk-ant-[\w-]{20,}|sk-[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{22,}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|ghu_[a-zA-Z0-9]{36,}|ghs_[a-zA-Z0-9]{36,}|glpat-[\w-]{20,}|xox[bp]-[\w-]{10,}|npm_[a-zA-Z0-9]{36,}|AIza[0-9A-Za-z_-]{35})\b/g;

const BEARER_TOKEN_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{20,})\b/gi;
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^:\s/@]*):([^@\s/]+)@/gi;

const GENERIC_SECRET_KEY = String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|client[_-]?secret|access[_-]?token|refresh[_-]?token)`;
const QUOTED_SECRET_FIELD_RE = new RegExp(String.raw`((?:["'])?${GENERIC_SECRET_KEY}(?:["'])?\s*[:=]\s*)(["'\`])([^"'\`\n]{6,})(\2)`, "gi");
const BARE_SECRET_FIELD_RE = new RegExp(String.raw`((?:["'])?${GENERIC_SECRET_KEY}(?:["'])?\s*[:=]\s*)([^\s,#}\]\["'\`]{6,})`, "gi");

function redactPreservingQuotes(prefix, value) {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
    return `${prefix}${quote}[REDACTED]${quote}`;
  }
  return `${prefix}[REDACTED]`;
}

export function scrubOutput(text) {
  let out = text;
  out = out.replace(PRIVATE_KEY_BLOCK_RE, "[REDACTED:private-key]");
  out = out.replace(ENV_SUFFIX_RE, (_match, prefix, value) => redactPreservingQuotes(prefix, value));
  out = out.replace(QUOTED_SECRET_FIELD_RE, "$1$2[REDACTED]$4");
  out = out.replace(BARE_SECRET_FIELD_RE, "$1[REDACTED]");
  out = out.replace(BEARER_TOKEN_RE, "$1[REDACTED]");
  out = out.replace(URL_CREDENTIALS_RE, "$1$2:[REDACTED]@");
  out = out.replace(TOKEN_PREFIX_RE, "[REDACTED]");
  return out;
}
