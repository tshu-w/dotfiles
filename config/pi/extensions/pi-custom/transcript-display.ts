import {
  AssistantMessageComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  keyText,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// Scoped private-API patch: retain Pi's live components and project only their display.
interface DisplayMode {
  chatContainer: Container;
  toolOutputExpanded: boolean;
  outputPad: number;
  session: { isStreaming: boolean };
  ui: { requestRender(force?: boolean): void };
  setToolsExpanded(expanded: boolean): void;
  showStatus(message: string): void;
}

type DisplayPrototype = {
  toggleToolOutputExpansion(this: DisplayMode): void;
  renderInitialMessages(this: DisplayMode): void;
  rebuildChatFromMessages(this: DisplayMode): void;
};

type AssistantView = {
  lastMessage?: AssistantMessage;
  isStreaming: boolean;
  markdownTheme: ConstructorParameters<typeof AssistantMessageComponent>[2];
  outputPad: number;
  markdownTransformers: ConstructorParameters<typeof AssistantMessageComponent>[5];
};

const FAILED = ["error", "aborted", "length"];

// A turn's start and the start of its last assistant message, in milliseconds.
type Turn = { start?: number; end?: number };

// As Codex shows elapsed time: 45s, 1m 05s, 1h 02m.
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

function isUserInput(child: Component): boolean {
  if (child instanceof UserMessageComponent) return true;
  // pi-agents marks the user's own input, which shows as a user message.
  return child instanceof CustomMessageComponent
    && (child as unknown as { message: { details?: { user?: boolean } } }).message.details?.user === true;
}

// A failure is recovered when its turn goes on before the next user input.
function recovered(children: Component[], index: number): boolean {
  for (const child of children.slice(index + 1)) {
    if (isUserInput(child)) return false;
    if (child instanceof ToolExecutionComponent) return true;
    if (child instanceof AssistantMessageComponent && (child as unknown as AssistantView).lastMessage) return true;
  }
  return false;
}

function compactTranscript(mode: DisplayMode, getTheme: () => Theme): () => void {
  mode.setToolsExpanded(false);
  const chat = mode.chatContainer;
  const render = chat.render;
  const handleMouse = chat.handleMouse;
  const invalidate = chat.invalidate;
  const projection = new Container();
  const assistants = new WeakMap<Component, { key: string; outputPad: number; component: AssistantMessageComponent }>();

  chat.render = (width) => {
    projection.clear();
    const children = chat.children;
    const streaming = mode.session.isStreaming;
    // A finished turn keeps only its last assistant text; earlier ones fold with its steps.
    const folded = new Set<Component>();
    const starts = new Map<number, Turn>();
    const first: Turn = {};
    let last = first;
    let turn: Component[] = [], ended = true;
    const finish = () => { for (const child of turn.slice(0, -1)) folded.add(child); turn = []; };
    for (const [index, child] of children.entries()) {
      // A custom message after the agent stopped, such as a notification, starts a turn of its own.
      if (isUserInput(child) || (ended && child instanceof CustomMessageComponent)) {
        finish();
        const stamp = child instanceof CustomMessageComponent ? child.message.timestamp : (child as unknown as { timestamp?: string | number }).timestamp;
        last = { start: stamp === undefined ? undefined : new Date(stamp).getTime() };
        starts.set(index, last);
        ended = false;
        continue;
      }
      const message = child instanceof AssistantMessageComponent ? (child as unknown as AssistantView).lastMessage : undefined;
      if (message) {
        ended = message.stopReason !== "toolUse";
        // Live user input has no timestamp; its first reply starts right after it.
        last.start ??= message.timestamp;
        last.end = message.timestamp;
      }
      if (!message?.content.some((part) => part.type === "text" && part.text.trim())) continue;
      if (!FAILED.includes(message.stopReason) || recovered(children, index)) turn.push(child);
    }
    if (!streaming) finish();
    const running = streaming ? last : undefined;
    let current = starts.get(0) ?? first, timed = false;
    let steps = 0, retries = 0, notes = false, messages = false;
    let tools: string[] = [];
    const theme = getTheme();
    const key = keyText("app.tools.expand");
    // Tool names are dropped from the end, then elided, before the label is truncated.
    const rule = (head: string, retry = "", names: string[] = []) => {
      const hint = key ? theme.fg("muted", head || retry ? ", " : "") + theme.fg("dim", key) + theme.fg("muted", " to expand") : "";
      const label = (shown: string[]) => theme.fg("muted", head) + retry + theme.fg("muted", shown.length ? `: ${shown.join(", ")}` : "") + hint;
      const room = Math.max(0, width - 4);
      let text = label(names);
      for (let count = names.length - 1; count >= 0 && visibleWidth(text) > room; count--) text = label([...names.slice(0, count), "…"]);
      text = truncateToWidth(text, room);
      // Pi puts a blank line before summaries already.
      const gap = projection.children.at(-1) instanceof Spacer ? "" : "\n";
      const line = theme.fg("borderMuted", "─ ") + text + theme.fg("borderMuted", ` ${"─".repeat(Math.max(1, width - 3 - visibleWidth(text)))}`);
      projection.addChild(new Text(`${gap}${truncateToWidth(line, width)}`, 0, 0));
    };
    const fold = () => {
      if (!steps && !retries && !notes) return;
      let head = steps ? `${steps} step${steps > 1 ? "s" : ""}` : "";
      // The first line of a turn tells how long it took, or has taken so far.
      if (!timed && current.start !== undefined) {
        const end = current === running ? Date.now() : current.end;
        if (end !== undefined) head = [`${current === running ? "Working" : "Worked"} for ${elapsed(end - current.start)}`, head].filter(Boolean).join(", ");
      }
      timed = true;
      const names = [...new Set(tools), ...(messages ? ["messages"] : [])];
      const retry = retries ? theme.fg("muted", head ? ", " : "") + theme.fg("warning", `${retries} ${retries > 1 ? "retries" : "retry"}`) : "";
      rule(head, retry, names);
      steps = retries = 0;
      notes = messages = false;
      tools = [];
    };
    for (const [index, child] of children.entries()) {
      const next = starts.get(index);
      if (next) {
        fold();
        current = next;
        timed = false;
      }
      if (child instanceof ToolExecutionComponent) {
        // The running turn shows its unfinished tool calls as Pi renders them.
        if (current === running && (child as unknown as { isPartial: boolean }).isPartial) {
          fold();
          projection.addChild(child);
          continue;
        }
        steps++;
        tools.push((child as unknown as { toolName: string }).toolName);
        continue;
      }
      if (child instanceof BranchSummaryMessageComponent || child instanceof CompactionSummaryMessageComponent) {
        fold();
        rule(child instanceof BranchSummaryMessageComponent ? "Branch summary" : "Compaction summary");
        continue;
      }
      if (child instanceof CustomMessageComponent && !isUserInput(child)) {
        steps++;
        messages = true;
        continue;
      }
      if (child instanceof AssistantMessageComponent) {
        const source = child as unknown as AssistantView;
        const message = source.lastMessage;
        if (!message) continue;
        const content = message.content.filter((part) => part.type === "text" && part.text.trim());
        const failed = FAILED.includes(message.stopReason);
        const retried = failed && recovered(children, index);
        if (!content.length && (!failed || retried)) {
          if (retried) retries++;
          continue;
        }
        if (folded.has(child)) {
          notes = true;
          if (retried) retries++;
          continue;
        }
        fold();
        // A retried failure keeps its text but not its error.
        const shown = retried ? { ...message, content, stopReason: "stop" as const, errorMessage: undefined } : { ...message, content };
        const key = JSON.stringify([content, shown.stopReason, shown.errorMessage, source.isStreaming, source.outputPad]);
        let cached = assistants.get(child);
        if (!cached || cached.key !== key) {
          const component = cached?.outputPad === source.outputPad
            ? cached.component
            : new AssistantMessageComponent(undefined, true, source.markdownTheme, "", source.outputPad, source.markdownTransformers);
          component.updateContent(shown, source.isStreaming);
          cached = { key, outputPad: source.outputPad, component };
          assistants.set(child, cached);
        }
        projection.addChild(cached.component);
        if (retried) retries++;
      } else {
        fold();
        projection.addChild(child);
      }
    }
    fold();
    return projection.render(width);
  };
  chat.handleMouse = (event) => projection.handleMouse(event);
  chat.invalidate = () => {
    invalidate.call(chat);
    projection.invalidate();
  };
  return () => {
    chat.render = render;
    chat.handleMouse = handleMouse;
    chat.invalidate = invalidate;
  };
}

// Each mode's view, kept across reinstalls: `/reload` rebuilds the chat before the new install.
const VIEWS = Symbol.for("pi-custom.transcript-display.views");

export function installTranscriptDisplay(prototype: DisplayPrototype, getTheme: () => Theme): () => void {
  const original = prototype.toggleToolOutputExpansion;
  const compact = new Map<DisplayMode, () => void>();
  const initialized = new WeakSet<DisplayMode>();
  const views = (prototype as { [VIEWS]?: Map<DisplayMode, boolean> })[VIEWS] ??= new Map();
  for (const [mode, compacted] of views) {
    initialized.add(mode);
    if (compacted) compact.set(mode, compactTranscript(mode, getTheme));
  }
  views.clear();
  const restoreRenderers = (["renderInitialMessages", "rebuildChatFromMessages"] as const).map((name) => {
    const render = prototype[name];
    function wrapped(this: DisplayMode) {
      if (!initialized.has(this)) {
        initialized.add(this);
        compact.set(this, compactTranscript(this, getTheme));
      }
      return render.call(this);
    }
    prototype[name] = wrapped;
    return () => { if (prototype[name] === wrapped) prototype[name] = render; };
  });
  function toggle(this: DisplayMode) {
    const showStatus = this.showStatus;
    this.showStatus = () => {};
    try {
      const restore = compact.get(this);
      if (restore) {
        restore();
        compact.delete(this);
        this.setToolsExpanded(false);
      } else if (this.toolOutputExpanded) {
        compact.set(this, compactTranscript(this, getTheme));
      } else {
        original.call(this);
      }
    } finally {
      this.showStatus = showStatus;
    }
    this.ui.requestRender(true);
  }
  prototype.toggleToolOutputExpansion = toggle;
  return () => {
    for (const [mode, restore] of compact) {
      views.set(mode, true);
      restore();
    }
    compact.clear();
    for (const restore of restoreRenderers) restore();
    if (prototype.toggleToolOutputExpansion === toggle) prototype.toggleToolOutputExpansion = original;
  };
}

