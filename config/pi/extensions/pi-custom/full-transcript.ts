// TUI-only full transcript restoration for pi 0.80.6. InteractiveMode uses
// compaction-aware entries for transcript rendering, so resumed and rebuilt
// chats start at the latest compaction boundary. This scoped patch can render
// the complete active branch without changing model context construction.

type RenderMethod = (this: TranscriptMode, ...args: unknown[]) => unknown;

interface TranscriptSessionManager {
  buildContextEntries(): unknown[];
  getBranch(): unknown[];
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
  restore(): void;
}

function renderWithFullBranch(
  mode: TranscriptMode,
  original: RenderMethod,
  args: unknown[],
): unknown {
  const manager = mode.sessionManager;
  const ownDescriptor = Object.getOwnPropertyDescriptor(manager, "buildContextEntries");

  try {
    Object.defineProperty(manager, "buildContextEntries", {
      configurable: true,
      value: () => manager.getBranch(),
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

  if (typeof originalInitial !== "function" || typeof originalRebuild !== "function") {
    return {
      getView: () => view,
      setView: (next) => { view = next; },
      restore: () => {},
    };
  }

  const render = (mode: TranscriptMode, original: RenderMethod, args: unknown[]) => {
    activeMode = mode;
    return view === "full"
      ? renderWithFullBranch(mode, original, args)
      : original.apply(mode, args);
  };
  const renderInitialMessages: RenderMethod = function (...args) {
    return render(this, originalInitial, args);
  };
  const rebuildChatFromMessages: RenderMethod = function (...args) {
    return render(this, originalRebuild, args);
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
    restore: () => {
      activeMode = undefined;
      if (prototype.renderInitialMessages === renderInitialMessages) {
        prototype.renderInitialMessages = originalInitial;
      }
      if (prototype.rebuildChatFromMessages === rebuildChatFromMessages) {
        prototype.rebuildChatFromMessages = originalRebuild;
      }
    },
  };
}
