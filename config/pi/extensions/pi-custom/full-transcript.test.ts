import assert from "node:assert/strict";
import test from "node:test";
import { installTranscriptView } from "./full-transcript.ts";

interface Entry {
  id: string;
  type: string;
}

interface FakeMode {
  sessionManager: {
    buildContextEntries(): Entry[];
    getBranch(): Entry[];
  };
  rendered?: Entry[];
  rebuildChatFromMessages(): void;
}

function createFixture() {
  const prototype = {
    renderInitialMessages(this: FakeMode) {
      this.rendered = this.sessionManager.buildContextEntries();
    },
    rebuildChatFromMessages(this: FakeMode) {
      this.rendered = this.sessionManager.buildContextEntries();
    },
  };
  const mode = Object.create(prototype) as FakeMode;
  const old = { id: "old", type: "message" };
  const summary = { id: "summary", type: "compaction" };
  const kept = { id: "kept", type: "message" };
  const latest = { id: "new", type: "message" };
  const compacted = [summary, kept, latest];
  const full = [old, summary, kept, latest];
  mode.sessionManager = Object.create({
    buildContextEntries: () => compacted,
    getBranch: () => full,
  }) as FakeMode["sessionManager"];
  return { prototype, mode, compacted, full };
}

test("renders the configured initial transcript view", () => {
  const fullFixture = createFixture();
  const fullControl = installTranscriptView(fullFixture.prototype, "full");
  fullFixture.prototype.renderInitialMessages.call(fullFixture.mode);
  assert.deepEqual(fullFixture.mode.rendered, fullFixture.full);
  fullControl.restore();

  const compactFixture = createFixture();
  const compactControl = installTranscriptView(compactFixture.prototype, "compact");
  compactFixture.prototype.renderInitialMessages.call(compactFixture.mode);
  assert.deepEqual(compactFixture.mode.rendered, compactFixture.compacted);
  compactControl.restore();
});

test("omits a just-saved compaction from one full rebuild", () => {
  const { prototype, mode, full } = createFixture();
  const control = installTranscriptView(prototype, "full");

  control.omitCompactionOnNextRebuild("summary");
  prototype.rebuildChatFromMessages.call(mode);
  assert.deepEqual(mode.rendered, full.filter((entry) => entry.id !== "summary"));

  prototype.rebuildChatFromMessages.call(mode);
  assert.deepEqual(mode.rendered, full);
  control.restore();
});

test("switches views immediately without changing normal context building", () => {
  const { prototype, mode, full, compacted } = createFixture();
  const originalBuilder = mode.sessionManager.buildContextEntries;
  const control = installTranscriptView(prototype, "compact");

  prototype.renderInitialMessages.call(mode);
  assert.deepEqual(mode.rendered, compacted);

  control.setView("full");
  assert.deepEqual(mode.rendered, full);
  assert.equal(mode.sessionManager.buildContextEntries, originalBuilder);
  assert.deepEqual(mode.sessionManager.buildContextEntries(), compacted);

  control.setView("compact");
  assert.deepEqual(mode.rendered, compacted);
  assert.equal(mode.sessionManager.buildContextEntries, originalBuilder);

  control.restore();
  prototype.renderInitialMessages.call(mode);
  assert.deepEqual(mode.rendered, compacted);
});
