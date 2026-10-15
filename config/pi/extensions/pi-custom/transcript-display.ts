import {
  AssistantMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  keyText,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
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
    let tools: string[] = [];
    const summarize = (summary: string) => {
      const theme = getTheme();
      const key = keyText("app.tools.expand");
      const label = theme.fg("muted", `... (${summary}`)
        + (key ? theme.fg("muted", ", ") + theme.fg("dim", key) + theme.fg("muted", " to expand") : "")
        + theme.fg("muted", ")");
      const padding = Math.min(mode.outputPad, Math.max(0, width));
      projection.addChild(new Text(`\n${truncateToWidth(" ".repeat(padding) + label, width)}`, 0, 0));
    };
    const fold = () => {
      if (!tools.length) return;
      summarize(`${tools.length} tool call${tools.length > 1 ? "s" : ""}: ${[...new Set(tools)].join(", ")}`);
      tools = [];
    };
    for (const child of chat.children) {
      if (child instanceof ToolExecutionComponent) {
        tools.push((child as unknown as { toolName: string }).toolName);
        continue;
      }
      if (child instanceof CustomMessageComponent) {
        const { customType, details } = (child as unknown as {
          message: { customType: string; details?: { user?: boolean; from?: { name?: string; id?: string } } };
        }).message;
        if (details?.user !== true) {
          fold();
          summarize(`message from ${details?.from?.name ?? details?.from?.id ?? customType}`);
          continue;
        }
      }
      if (child instanceof AssistantMessageComponent) {
        const source = child as unknown as AssistantView;
        const message = source.lastMessage;
        if (!message) continue;
        const content = message.content.filter((part) => part.type === "text" && part.text.trim());
        if (!content.length && !["error", "aborted", "length"].includes(message.stopReason)) continue;
        fold();
        const key = JSON.stringify([content, message.stopReason, message.errorMessage, source.isStreaming, source.outputPad]);
        let cached = assistants.get(child);
        if (!cached || cached.key !== key) {
          const component = new AssistantMessageComponent(undefined, true, source.markdownTheme, "", source.outputPad, source.markdownTransformers);
          component.updateContent({ ...message, content }, source.isStreaming);
          cached = { key, component };
          assistants.set(child, cached);
        }
        projection.addChild(cached.component);
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

