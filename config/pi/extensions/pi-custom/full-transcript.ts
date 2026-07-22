// TUI-only full transcript restoration for pi 0.80.6. InteractiveMode uses
// compaction-aware entries for transcript rendering, so resumed and rebuilt
// chats start at the latest compaction boundary. This scoped patch can render
// the complete active branch without changing model context construction.
// During live compaction, the saved boundary is omitted from the first rebuild
// because core appends an equivalent synthetic summary immediately afterward.

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

export type TranscriptView = "full" | "compact";

export interface TranscriptViewControl {
  getView(): TranscriptView;
  setView(view: TranscriptView): void;
  omitCompactionOnNextRebuild(entryId: string): void;
  restore(): void;
}

function renderWithFullBranch(
  mode: TranscriptMode,
  original: RenderMethod,
  args: unknown[],
  omittedCompactionId?: string,
): unknown {
  const manager = mode.sessionManager;
  const ownDescriptor = Object.getOwnPropertyDescriptor(manager, "buildContextEntries");

  try {
    Object.defineProperty(manager, "buildContextEntries", {
      configurable: true,
      value: () => manager.getBranch().filter((entry) =>
        entry.type !== "compaction" || entry.id !== omittedCompactionId
      ),
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

export function installTranscriptView(
  prototype: TranscriptRendererPrototype,
  initialView: TranscriptView,
): TranscriptViewControl {
  const originalInitial = prototype.renderInitialMessages;
  const originalRebuild = prototype.rebuildChatFromMessages;
  let view = initialView;
  let activeMode: TranscriptMode | undefined;
  let compactionIdToOmit: string | undefined;

  if (typeof originalInitial !== "function" || typeof originalRebuild !== "function") {
    return {
      getView: () => view,
      setView: (next) => { view = next; },
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
    return view === "full"
      ? renderWithFullBranch(mode, original, args, omittedCompactionId)
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

  return {
    getView: () => view,
    setView: (next) => {
      if (view === next) return;
      view = next;
      activeMode?.rebuildChatFromMessages();
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
