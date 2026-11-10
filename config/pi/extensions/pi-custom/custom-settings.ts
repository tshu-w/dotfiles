import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const CUSTOM_SETTINGS_ENTRY_TYPE = "pi-custom:settings";
const SETTINGS_DOCUMENT_KEY = "pi-custom";

export interface PiCustomSettings {
  fast: boolean;
  transcriptOptimization: boolean;
}

export type CustomSetting = keyof PiCustomSettings;
const CUSTOM_SETTING_KEYS = [
  "fast",
  "transcriptOptimization",
] as const satisfies readonly CustomSetting[];
export type CustomSettingScope = "global" | "session";
export type SessionCustomSettings = Partial<PiCustomSettings>;
export type ResolvedCustomSettings = {
  [K in CustomSetting]: {
    value: PiCustomSettings[K];
    scope: CustomSettingScope;
  };
};

export const DEFAULT_CUSTOM_SETTINGS: PiCustomSettings = {
  fast: false,
  transcriptOptimization: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSessionSettings(value: unknown): SessionCustomSettings {
  if (!isRecord(value)) return {};
  const settings: SessionCustomSettings = {};
  for (const key of CUSTOM_SETTING_KEYS) {
    if (typeof value[key] === "boolean") settings[key] = value[key];
  }
  return settings;
}

export function parseGlobalSettings(value: unknown): PiCustomSettings {
  return { ...DEFAULT_CUSTOM_SETTINGS, ...parseSessionSettings(value) };
}

function readSettingsDocument(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

// Settings live under the "pi-custom" key of pi's global settings.json; pi
// preserves unknown top-level keys when saving its own settings.
export function readGlobalSettings(path: string): PiCustomSettings {
  try {
    const document = readSettingsDocument(path);
    if (isRecord(document[SETTINGS_DOCUMENT_KEY])) {
      return parseGlobalSettings(document[SETTINGS_DOCUMENT_KEY]);
    }
  } catch {
    // Fall through to defaults.
  }
  return { ...DEFAULT_CUSTOM_SETTINGS };
}

function writeGlobalSetting<K extends CustomSetting>(
  path: string,
  field: K,
  value: PiCustomSettings[K],
): PiCustomSettings {
  // Read and merge just before writing; a concurrent writer's last write wins.
  // Throws instead of clobbering settings.json when it cannot be parsed.
  const document = existsSync(path) ? readSettingsDocument(path) : {};
  const current = isRecord(document[SETTINGS_DOCUMENT_KEY])
    ? parseGlobalSettings(document[SETTINGS_DOCUMENT_KEY])
    : { ...DEFAULT_CUSTOM_SETTINGS };
  const settings = { ...current, [field]: value };
  document[SETTINGS_DOCUMENT_KEY] = settings;
  // Rename into place, so Pi never reads a half-written file.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
  renameSync(temporary, path);
  return settings;
}

export function restoreSessionSettings(entries: unknown[]): SessionCustomSettings {
  let restored: SessionCustomSettings = {};
  for (const entry of entries) {
    if (
      !isRecord(entry)
      || entry.type !== "custom"
      || entry.customType !== CUSTOM_SETTINGS_ENTRY_TYPE
    ) continue;
    restored = parseSessionSettings(entry.data);
  }
  return restored;
}

function normalizeSessionSettings(
  global: PiCustomSettings,
  session: SessionCustomSettings,
): SessionCustomSettings {
  const normalized = { ...session };
  for (const key of CUSTOM_SETTING_KEYS) {
    if (normalized[key] === global[key]) delete normalized[key];
  }
  return normalized;
}

export function resolveCustomSettings(
  global: PiCustomSettings,
  session: SessionCustomSettings,
): ResolvedCustomSettings {
  const resolved = {} as ResolvedCustomSettings;
  for (const key of CUSTOM_SETTING_KEYS) {
    resolved[key] = session[key] === undefined
      ? { value: global[key], scope: "global" }
      : { value: session[key], scope: "session" };
  }
  return resolved;
}

interface CreateCustomPreferencesOptions {
  path: string;
  appendSession(settings: SessionCustomSettings): void;
  global?: PiCustomSettings;
  session?: SessionCustomSettings;
}

export interface CustomPreferences {
  get(): ResolvedCustomSettings;
  setSession<K extends CustomSetting>(field: K, value: PiCustomSettings[K]): void;
  saveGlobal(field: CustomSetting): void;
  resetSession(field: CustomSetting): void;
  restore(entries: unknown[]): void;
  onChange(listener: () => void): () => void;
}

export function createCustomPreferences(
  options: CreateCustomPreferencesOptions,
): CustomPreferences {
  let global = options.global ?? readGlobalSettings(options.path);
  let session = normalizeSessionSettings(global, options.session ?? {});
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const appendSession = () => options.appendSession({ ...session });

  return {
    get: () => resolveCustomSettings(global, session),
    setSession: (field, value) => {
      session = { ...session, [field]: value };
      if (value === global[field]) delete session[field];
      appendSession();
      emit();
    },
    saveGlobal: (field) => {
      const value = resolveCustomSettings(global, session)[field].value;
      global = writeGlobalSetting(options.path, field, value);
      session = { ...session };
      delete session[field];
      appendSession();
      emit();
    },
    resetSession: (field) => {
      session = { ...session };
      delete session[field];
      appendSession();
      emit();
    },
    restore: (entries) => {
      global = readGlobalSettings(options.path);
      session = normalizeSessionSettings(global, restoreSessionSettings(entries));
      emit();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
