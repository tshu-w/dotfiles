import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const CUSTOM_SETTINGS_ENTRY_TYPE = "pi-custom:settings";

export interface PiCustomSettings {
  fast: boolean;
  transcriptOptimization: boolean;
}

export type CustomSetting = keyof PiCustomSettings;
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
  if (typeof value.fast === "boolean") settings.fast = value.fast;
  if (typeof value.transcriptOptimization === "boolean") {
    settings.transcriptOptimization = value.transcriptOptimization;
  }
  return settings;
}

export function parseGlobalSettings(value: unknown): PiCustomSettings {
  const settings = parseSessionSettings(value);
  return {
    fast: settings.fast ?? DEFAULT_CUSTOM_SETTINGS.fast,
    transcriptOptimization:
      settings.transcriptOptimization ?? DEFAULT_CUSTOM_SETTINGS.transcriptOptimization,
  };
}

export function readGlobalSettings(path: string): PiCustomSettings {
  if (!existsSync(path)) return { ...DEFAULT_CUSTOM_SETTINGS };
  try {
    return parseGlobalSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_CUSTOM_SETTINGS };
  }
}

function writeGlobalSettings(path: string, settings: PiCustomSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temporary, path);
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
  if (normalized.fast === global.fast) delete normalized.fast;
  if (normalized.transcriptOptimization === global.transcriptOptimization) {
    delete normalized.transcriptOptimization;
  }
  return normalized;
}

export function resolveCustomSettings(
  global: PiCustomSettings,
  session: SessionCustomSettings,
): ResolvedCustomSettings {
  return {
    fast: session.fast === undefined
      ? { value: global.fast, scope: "global" }
      : { value: session.fast, scope: "session" },
    transcriptOptimization: session.transcriptOptimization === undefined
      ? { value: global.transcriptOptimization, scope: "global" }
      : { value: session.transcriptOptimization, scope: "session" },
  };
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
      session = { ...session };
      if (value === global[field]) delete session[field];
      else session = { ...session, [field]: value };
      appendSession();
      emit();
    },
    saveGlobal: (field) => {
      const value = resolveCustomSettings(global, session)[field].value;
      global = { ...global, [field]: value };
      writeGlobalSettings(options.path, global);
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
