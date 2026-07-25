import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCustomPreferences,
  DEFAULT_CUSTOM_SETTINGS,
  parseGlobalSettings,
  readGlobalSettings,
  resolveCustomSettings,
  restoreSessionSettings,
} from "./custom-settings.ts";

test("session settings override global defaults per field", () => {
  assert.deepEqual(
    resolveCustomSettings(
      { fast: false, codexCompaction: true, transcriptOptimization: true },
      { fast: true },
    ),
    {
      fast: { value: true, scope: "session" },
      codexCompaction: { value: true, scope: "global" },
      transcriptOptimization: { value: true, scope: "global" },
    },
  );
});

test("global settings use defaults for missing or invalid values", () => {
  assert.deepEqual(parseGlobalSettings({}), DEFAULT_CUSTOM_SETTINGS);
  assert.deepEqual(
    parseGlobalSettings({ fast: true, codexCompaction: false, transcriptOptimization: false }),
    { fast: true, codexCompaction: false, transcriptOptimization: false },
  );
  assert.deepEqual(
    parseGlobalSettings({ fast: "yes", codexCompaction: 1, transcriptOptimization: "yes" }),
    DEFAULT_CUSTOM_SETTINGS,
  );
});

test("global settings are read from the pi-custom key of settings.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-custom-settings-"));
  const path = join(directory, "settings.json");
  try {
    assert.deepEqual(readGlobalSettings(path), DEFAULT_CUSTOM_SETTINGS);

    writeFileSync(path, JSON.stringify({ defaultModel: "m", "pi-custom": { fast: true } }));
    assert.deepEqual(readGlobalSettings(path), { ...DEFAULT_CUSTOM_SETTINGS, fast: true });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("session restoration uses the latest active-branch settings entry", () => {
  const entries = [
    {
      type: "custom",
      customType: "pi-custom:settings",
      data: { fast: true },
    },
    { type: "message" },
    {
      type: "custom",
      customType: "pi-custom:settings",
      data: { transcriptOptimization: false },
    },
  ];

  assert.deepEqual(restoreSessionSettings(entries), { transcriptOptimization: false });
});

test("setting a session value equal to global clears the redundant override", () => {
  const normalized = createCustomPreferences({
    path: "/unused/settings.json",
    appendSession: () => {},
    global: { fast: false, codexCompaction: true, transcriptOptimization: true },
    session: { fast: false },
  });
  assert.deepEqual(normalized.get().fast, { value: false, scope: "global" });

  const appended: unknown[] = [];
  const preferences = createCustomPreferences({
    path: "/unused/settings.json",
    appendSession: (value) => appended.push(value),
    global: { fast: false, codexCompaction: true, transcriptOptimization: true },
    session: { fast: true },
  });

  preferences.setSession("fast", false);

  assert.deepEqual(preferences.get().fast, { value: false, scope: "global" });
  assert.deepEqual(appended.at(-1), {});
});

test("saving one global field preserves other settings and foreign keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-custom-settings-"));
  const path = join(directory, "settings.json");
  const appended: unknown[] = [];
  try {
    writeFileSync(path, JSON.stringify({ defaultModel: "m", extensions: ["a.ts"] }));
    const preferences = createCustomPreferences({
      path,
      appendSession: (value) => appended.push(value),
      global: { fast: false, codexCompaction: true, transcriptOptimization: true },
      session: { fast: true, transcriptOptimization: false },
    });

    preferences.saveGlobal("fast");

    assert.deepEqual(preferences.get(), {
      fast: { value: true, scope: "global" },
      codexCompaction: { value: true, scope: "global" },
      transcriptOptimization: { value: false, scope: "session" },
    });
    assert.deepEqual(appended.at(-1), { transcriptOptimization: false });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      defaultModel: "m",
      extensions: ["a.ts"],
      "pi-custom": { fast: true, codexCompaction: true, transcriptOptimization: true },
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});
