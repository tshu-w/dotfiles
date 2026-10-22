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
  const assistants = new WeakMap<Component, { key: string; component: AssistantMessageComponent }>();

  chat.render = (width) => {
    projection.clear();
    let steps = 0, retries = 0, messages = false;
    let tools: string[] = [];
    // `names` are dropped from the end, then elided, until the line fits.
    const summarize = (head: string, names: string[] = [], warning = "") => {
      const theme = getTheme();
      const key = keyText("app.tools.expand");
      const padding = Math.min(mode.outputPad, Math.max(0, width));
      const hint = key ? theme.fg("muted", ", ") + theme.fg("dim", key) + theme.fg("muted", " to expand") : "";
      const tail = (warning ? theme.fg("muted", " · ") + theme.fg("warning", warning) : "") + hint + theme.fg("muted", ")");
      const line = (shown: string[]) => " ".repeat(padding)
        + theme.fg("muted", `... (${head}${shown.length ? `: ${shown.join(", ")}` : ""}`) + tail;
      let label = line(names);
      for (let count = names.length - 1; count >= 0 && visibleWidth(label) > width; count--) {
        label = line([...names.slice(0, count), "…"]);
      }
      // Pi puts a blank line before summaries already.
      const gap = projection.children.at(-1) instanceof Spacer ? "" : "\n";
      projection.addChild(new Text(`${gap}${truncateToWidth(label, width)}`, 0, 0));
    };
    const fold = () => {
      if (!steps && !retries) return;
      const retry = retries ? `${retries} ${retries > 1 ? "retries" : "retry"}` : "";
      if (steps) summarize(`${steps} step${steps > 1 ? "s" : ""}`, [...new Set(tools), ...(messages ? ["messages"] : [])], retry);
      else summarize(retry);
      steps = retries = 0;
      messages = false;
      tools = [];
    };
    const children = chat.children;
    for (const [index, child] of children.entries()) {
      if (child instanceof ToolExecutionComponent) {
        steps++;
        tools.push((child as unknown as { toolName: string }).toolName);
        continue;
      }
      if (child instanceof BranchSummaryMessageComponent || child instanceof CompactionSummaryMessageComponent) {
        fold();
        summarize(child instanceof BranchSummaryMessageComponent ? "branch summary" : "compaction summary");
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
        fold();
        // A retried failure keeps its text but not its error.
        const shown = retried ? { ...message, content, stopReason: "stop" as const, errorMessage: undefined } : { ...message, content };
        const key = JSON.stringify([content, shown.stopReason, shown.errorMessage, source.isStreaming, source.outputPad]);
        let cached = assistants.get(child);
        if (!cached || cached.key !== key) {
          const component = new AssistantMessageComponent(undefined, true, source.markdownTheme, "", source.outputPad, source.markdownTransformers);
          component.updateContent(shown, source.isStreaming);
          cached = { key, component };
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

export function installTranscriptDisplay(prototype: DisplayPrototype, getTheme: () => Theme): () => void {
  const original = prototype.toggleToolOutputExpansion;
  const compact = new Map<DisplayMode, () => void>();
  const initialized = new WeakSet<DisplayMode>();
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
    for (const restore of compact.values()) restore();
    compact.clear();
    for (const restore of restoreRenderers) restore();
    if (prototype.toggleToolOutputExpansion === toggle) prototype.toggleToolOutputExpansion = original;
  };
}

