import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCustomPreferences,
  DEFAULT_CUSTOM_SETTINGS,
  parseGlobalSettings,
  resolveCustomSettings,
  restoreSessionSettings,
} from "./custom-settings.ts";

test("session settings override global defaults per field", () => {
  assert.deepEqual(
    resolveCustomSettings(
      { fast: false, transcriptOptimization: true },
      { fast: true },
    ),
    {
      fast: { value: true, scope: "session" },
      transcriptOptimization: { value: true, scope: "global" },
    },
  );
});

test("global settings use defaults for missing or invalid values", () => {
  assert.deepEqual(parseGlobalSettings({}), DEFAULT_CUSTOM_SETTINGS);
  assert.deepEqual(
    parseGlobalSettings({ fast: true, transcriptOptimization: false }),
    { fast: true, transcriptOptimization: false },
  );
  assert.deepEqual(
    parseGlobalSettings({ fast: "yes", transcriptOptimization: "yes" }),
    DEFAULT_CUSTOM_SETTINGS,
  );
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
    path: "/unused/pi-custom.json",
    appendSession: () => {},
    global: { fast: false, transcriptOptimization: true },
    session: { fast: false },
  });
  assert.deepEqual(normalized.get().fast, { value: false, scope: "global" });

  const appended: unknown[] = [];
  const preferences = createCustomPreferences({
    path: "/unused/pi-custom.json",
    appendSession: (value) => appended.push(value),
    global: { fast: false, transcriptOptimization: true },
    session: { fast: true },
  });

  preferences.setSession("fast", false);

  assert.deepEqual(preferences.get().fast, { value: false, scope: "global" });
  assert.deepEqual(appended.at(-1), {});
});

test("saving one global field preserves the other global setting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-custom-settings-"));
  const path = join(directory, "pi-custom.json");
  const appended: unknown[] = [];
  try {
    const preferences = createCustomPreferences({
      path,
      appendSession: (value) => appended.push(value),
      global: { fast: false, transcriptOptimization: true },
      session: { fast: true, transcriptOptimization: false },
    });

    preferences.saveGlobal("fast");

    assert.deepEqual(preferences.get(), {
      fast: { value: true, scope: "global" },
      transcriptOptimization: { value: false, scope: "session" },
    });
    assert.deepEqual(appended.at(-1), { transcriptOptimization: false });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      fast: true,
      transcriptOptimization: true,
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});
