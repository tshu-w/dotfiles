// TUI-only transcript history paging for pi 0.80.6. InteractiveMode renders
// only compaction-aware entries by default. This scoped patch keeps that fast
// recent view, while allowing older compaction intervals or the full active
// branch to be loaded temporarily without changing model context construction.
// During live compaction, the saved boundary is omitted from the first expanded
// rebuild because core appends an equivalent synthetic summary immediately after.

type RenderMethod = (this: TranscriptMode, ...args: unknown[]) => unknown;

interface TranscriptEntry {
  id?: string;
  type?: string;
}

interface TranscriptSessionManager {
  buildContextEntries(): TranscriptEntry[];
  getBranch(): TranscriptEntry[];
}

interface TranscriptMode {
  sessionManager: TranscriptSessionManager;
  rebuildChatFromMessages(): unknown;
}

interface TranscriptRendererPrototype {
  renderInitialMessages: RenderMethod;
  rebuildChatFromMessages: RenderMethod;
}

export interface TranscriptHistoryControl {
  getStatus(): string;
  showOlder(): void;
  showRecent(): void;
  showFull(): void;
  omitCompactionOnNextRebuild(entryId: string): void;
  restore(): void;
}

function renderWithEntries(
  mode: TranscriptMode,
  original: RenderMethod,
  args: unknown[],
  entries: TranscriptEntry[],
): unknown {
  const manager = mode.sessionManager;
  const ownDescriptor = Object.getOwnPropertyDescriptor(manager, "buildContextEntries");

  try {
    Object.defineProperty(manager, "buildContextEntries", {
      configurable: true,
      value: () => entries,
      writable: true,
    });
  } catch {
    return original.apply(mode, args);
  }

  try {
    return original.apply(mode, args);
  } finally {
    if (ownDescriptor) Object.defineProperty(manager, "buildContextEntries", ownDescriptor);
    else delete (manager as Partial<TranscriptSessionManager>).buildContextEntries;
  }
}

function expandedEntries(
  manager: TranscriptSessionManager,
  olderSections: number,
  full: boolean,
  omittedCompactionId?: string,
): TranscriptEntry[] | undefined {
  if (!full && olderSections === 0) return undefined;
  const branch = manager.getBranch().filter((entry) =>
    entry.type !== "compaction" || entry.id !== omittedCompactionId
  );
  if (full) return branch;

  const compactionIndices: number[] = [];
  for (const [index, entry] of branch.entries()) {
    if (entry.type === "compaction") compactionIndices.push(index);
  }
  const start = compactionIndices.at(-(olderSections + 1)) ?? 0;
  return branch.slice(start);
}

export function installTranscriptHistory(
  prototype: TranscriptRendererPrototype,
): TranscriptHistoryControl {
  const originalInitial = prototype.renderInitialMessages;
  const originalRebuild = prototype.rebuildChatFromMessages;
  let olderSections = 0;
  let full = false;
  let activeMode: TranscriptMode | undefined;
  let compactionIdToOmit: string | undefined;

  if (typeof originalInitial !== "function" || typeof originalRebuild !== "function") {
    return {
      getStatus: () => "Recent",
      showOlder: () => {},
      showRecent: () => {},
      showFull: () => {},
      omitCompactionOnNextRebuild: () => {},
      restore: () => {},
    };
  }

  const render = (
    mode: TranscriptMode,
    original: RenderMethod,
    args: unknown[],
    omittedCompactionId?: string,
  ) => {
    activeMode = mode;
    const entries = expandedEntries(
      mode.sessionManager,
      olderSections,
      full,
      omittedCompactionId,
    );
    return entries
      ? renderWithEntries(mode, original, args, entries)
      : original.apply(mode, args);
  };
  const renderInitialMessages: RenderMethod = function (...args) {
    return render(this, originalInitial, args);
  };
  const rebuildChatFromMessages: RenderMethod = function (...args) {
    const omittedCompactionId = compactionIdToOmit;
    compactionIdToOmit = undefined;
    return render(this, originalRebuild, args, omittedCompactionId);
  };

  prototype.renderInitialMessages = renderInitialMessages;
  prototype.rebuildChatFromMessages = rebuildChatFromMessages;

  const rebuild = () => activeMode?.rebuildChatFromMessages();
  return {
    getStatus: () => full ? "Full" : olderSections > 0 ? `${olderSections} older` : "Recent",
    showOlder: () => {
      const maxSections = activeMode
        ? activeMode.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length
        : olderSections + 1;
      const next = Math.min(olderSections + 1, maxSections);
      if (!full && next === olderSections) return;
      full = false;
      olderSections = next;
      rebuild();
    },
    showRecent: () => {
      if (!full && olderSections === 0) return;
      full = false;
      olderSections = 0;
      rebuild();
    },
    showFull: () => {
      if (full) return;
      full = true;
      rebuild();
    },
    omitCompactionOnNextRebuild: (entryId) => {
      compactionIdToOmit = entryId;
    },
    restore: () => {
      activeMode = undefined;
      compactionIdToOmit = undefined;
      if (prototype.renderInitialMessages === renderInitialMessages) {
        prototype.renderInitialMessages = originalInitial;
      }
      if (prototype.rebuildChatFromMessages === rebuildChatFromMessages) {
        prototype.rebuildChatFromMessages = originalRebuild;
      }
    },
  };
}
