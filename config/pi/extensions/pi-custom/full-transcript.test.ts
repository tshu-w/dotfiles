import assert from "node:assert/strict";
import test from "node:test";
import { installTranscriptView } from "./full-transcript.ts";

interface FakeMode {
  sessionManager: {
    buildContextEntries(): string[];
    getBranch(): string[];
  };
  rendered?: string[];
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
  const compacted = ["summary", "kept", "new"];
  const full = ["old", "summary", "kept", "new"];
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
