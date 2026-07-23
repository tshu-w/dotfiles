import assert from "node:assert/strict";
import test from "node:test";
import { installTranscriptHistory } from "../full-transcript.ts";

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
  const beforeFirst = { id: "before-first", type: "message" };
  const first = { id: "first", type: "compaction" };
  const betweenFirstAndSecond = { id: "between-1-2", type: "message" };
  const second = { id: "second", type: "compaction" };
  const betweenSecondAndLatest = { id: "between-2-3", type: "message" };
  const latestSummary = { id: "latest-summary", type: "compaction" };
  const kept = { id: "kept", type: "message" };
  const latest = { id: "new", type: "message" };
  const compacted = [latestSummary, kept, latest];
  const full = [
    beforeFirst,
    first,
    betweenFirstAndSecond,
    second,
    betweenSecondAndLatest,
    latestSummary,
    kept,
    latest,
  ];
  mode.sessionManager = Object.create({
    buildContextEntries: () => compacted,
    getBranch: () => full,
  }) as FakeMode["sessionManager"];
  return { prototype, mode, compacted, full };
}

test("starts with the compact transcript", () => {
  const { prototype, mode, compacted } = createFixture();
  const control = installTranscriptHistory(prototype);

  prototype.renderInitialMessages.call(mode);

  assert.deepEqual(mode.rendered, compacted);
  assert.equal(control.getStatus(), "Recent");
  control.restore();
});

test("loads one older compaction interval at a time", () => {
  const { prototype, mode, full } = createFixture();
  const control = installTranscriptHistory(prototype);
  prototype.renderInitialMessages.call(mode);

  control.showOlder();
  assert.deepEqual(mode.rendered, full.slice(3));
  assert.equal(control.getStatus(), "1 older");

  control.showOlder();
  assert.deepEqual(mode.rendered, full.slice(1));
  assert.equal(control.getStatus(), "2 older");

  control.showOlder();
  assert.deepEqual(mode.rendered, full);
  assert.equal(control.getStatus(), "3 older");
  control.restore();
});

test("switches between full and recent without changing model context", () => {
  const { prototype, mode, full, compacted } = createFixture();
  const originalBuilder = mode.sessionManager.buildContextEntries;
  const control = installTranscriptHistory(prototype);
  prototype.renderInitialMessages.call(mode);

  control.showFull();
  assert.deepEqual(mode.rendered, full);
  assert.equal(control.getStatus(), "Full");
  assert.equal(mode.sessionManager.buildContextEntries, originalBuilder);

  control.showRecent();
  assert.deepEqual(mode.rendered, compacted);
  assert.equal(control.getStatus(), "Recent");
  assert.equal(mode.sessionManager.buildContextEntries, originalBuilder);
  control.restore();
});

test("omits a just-saved compaction from one expanded rebuild", () => {
  const { prototype, mode, full } = createFixture();
  const control = installTranscriptHistory(prototype);
  prototype.renderInitialMessages.call(mode);
  control.showFull();

  control.omitCompactionOnNextRebuild("latest-summary");
  prototype.rebuildChatFromMessages.call(mode);
  assert.deepEqual(mode.rendered, full.filter((entry) => entry.id !== "latest-summary"));

  prototype.rebuildChatFromMessages.call(mode);
  assert.deepEqual(mode.rendered, full);
  control.restore();
});
