import { basename, extname } from "node:path";

const ENV_ASSIGNMENT_RE = /\b([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)\s*=\s*)("[^"]*"|'[^']*'|[^\s\n#"']+)/g;
const TOKEN_PREFIX_RE = /\b(sk-ant-api\d{2}-[\w-]{80,}|sk-ant-[\w-]{20,}|sk-[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{22,}|ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|ghu_[a-zA-Z0-9]{36,}|ghs_[a-zA-Z0-9]{36,}|glpat-[\w-]{20,}|xox[bp]-[\w-]{10,}|npm_[a-zA-Z0-9]{36,}|AIza[0-9A-Za-z_-]{35})\b/g;
const BEARER_TOKEN_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{20,})\b/gi;
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^:\s/@]*):([^@\s/]+)@/gi;

const GENERIC_SECRET_KEY = String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|client[_-]?secret|access[_-]?token|refresh[_-]?token)`;
const JSON_QUOTED_SECRET_FIELD_RE = new RegExp(String.raw`((?:["'])${GENERIC_SECRET_KEY}(?:["'])\s*:\s*)(["'\x60])([^"'\x60\n]{6,})(\2)`, "gi");
const LINE_QUOTED_SECRET_FIELD_RE = new RegExp(String.raw`(^[ \t-]*(?:${GENERIC_SECRET_KEY})[ \t]*[:=][ \t]*)(["'\x60])([^"'\x60\n]{6,})(\2)`, "gim");
const LINE_BARE_SECRET_FIELD_RE = new RegExp(String.raw`(^[ \t-]*(?:${GENERIC_SECRET_KEY})[ \t]*[:=][ \t]*)([^\s,#}\]\["'\x60]{6,})`, "gim");

const CONFIG_EXTENSIONS = new Set([
  ".cfg",
  ".conf",
  ".config",
  ".ini",
  ".json",
  ".jsonc",
  ".jsonl",
  ".properties",
  ".toml",
  ".xml",
  ".yaml",
  ".yml",
]);
const CONFIG_FILENAMES = new Set([".npmrc", ".pypirc"]);

function redactPreservingQuotes(prefix, value) {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
    return `${prefix}${quote}[REDACTED]${quote}`;
  }
  return `${prefix}[REDACTED]`;
}

export function isConfigLikePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return false;
  const name = basename(filePath).toLowerCase();
  if (name === ".env" || name.startsWith(".env.") || CONFIG_FILENAMES.has(name)) return true;
  return CONFIG_EXTENSIONS.has(extname(name));
}

export function scrubOutput(text, { envAssignments = false, genericFields = false } = {}) {
  let out = text;
  out = out.replace(PRIVATE_KEY_BLOCK_RE, "[REDACTED:private-key]");
  out = out.replace(BEARER_TOKEN_RE, "$1[REDACTED]");
  out = out.replace(URL_CREDENTIALS_RE, "$1$2:[REDACTED]@");
  out = out.replace(TOKEN_PREFIX_RE, "[REDACTED]");

  if (envAssignments) {
    out = out.replace(ENV_ASSIGNMENT_RE, (_match, prefix, value) => redactPreservingQuotes(prefix, value));
  }
  if (genericFields) {
    out = out.replace(JSON_QUOTED_SECRET_FIELD_RE, "$1$2[REDACTED]$4");
    out = out.replace(LINE_QUOTED_SECRET_FIELD_RE, "$1$2[REDACTED]$4");
    out = out.replace(LINE_BARE_SECRET_FIELD_RE, "$1[REDACTED]");
  }
  return out;
}
