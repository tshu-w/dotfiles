// Transcript render performance for long sessions — private-API workaround for
// pi 0.80.6 (upstream issue earendil-works/pi#6478). Two independent patches,
// both instance-level and fail-open:
//
// 1. applyLineResets memoization. Upstream rebuilds every line string on every
//    frame (normalize + reset suffix), which defeats the pointer-equality fast
//    path in the frame diff and makes typing latency grow with transcript
//    length. A bounded two-generation memo returns stable string references,
//    so steady-state frames drop to pointer work. Scrollback stays complete.
//
// 2. Cold-rebuild windowing. After the chat container is rebuilt or its width
//    changes, every component re-parses its markdown inside one synchronous
//    render. While caches are cold, only a message-aligned tail renders behind
//    a marker — sized by a ~100ms sync parse budget, not a fixed line count;
//    the rest warms up in background ticks, then one full redraw restores the
//    complete transcript into scrollback.
//
// Controlled through the pi-custom settings panel.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-custom-render-perf";
const MEMO_GENERATION_LIMIT = 65_536;
const COLD_COMPONENT_THRESHOLD = 48;
const COLD_SYNC_BUDGET_MS = 100;
const MIN_TAIL_LINES = 200;
const MAX_TAIL_LINES = 4000;
const MAX_TAIL_COMPONENTS = 256;
const WARM_BUDGET_MS = 8;
const WARM_INTERVAL_MS = 16;
const HIDDEN_MARKER = "… earlier messages rendering in background …";

const emptyWidget: Component = {
  render: () => [],
  invalidate: () => {},
};

export interface RenderPerfControl {
  isEnabled(): boolean;
  setEnabled(value: boolean): void;
}

function findChatContainer(tui: TUI): Container | undefined {
  // InteractiveMode 0.80.6 has exactly nine root children and chat at slot 2.
  // Exact count catches insertions/removals; a same-size reorder can still
  // evade this private-API guard, so benchmark after every pi upgrade.
  if (tui.children.length !== 9) return undefined;
  const candidate = tui.children[2];
  if (!(candidate instanceof Container)) return undefined;
  if (candidate.render !== Container.prototype.render) return undefined;
  return candidate;
}

export function registerRenderPerf(pi: ExtensionAPI): RenderPerfControl {
  let enabled = true;
  let restoreFns: Array<() => void> = [];
  let activeTui: TUI | undefined;

  // ── applyLineResets memo ──
  let memoNew = new Map<string, string>();
  let memoOld = new Map<string, string>();

  // ── cold-rebuild window ──
  let warmWidth = 0;
  let warmSet = new WeakSet<Component>();
  let childrenRef: readonly Component[] | undefined;
  let observedChildCount = 0;
  let cold = false;
  let anchorIndex = 0;
  let warmCursor = -1;
  let warmTimer: ReturnType<typeof setTimeout> | undefined;

  const stopWarm = () => {
    if (warmTimer) {
      clearTimeout(warmTimer);
      warmTimer = undefined;
    }
  };

  const restoreAll = () => {
    stopWarm();
    for (const restore of restoreFns) restore();
    restoreFns = [];
    childrenRef = undefined;
    observedChildCount = 0;
    cold = false;
    warmCursor = -1;
    activeTui = undefined;
  };

  const installMemoPatch = (tui: TUI): boolean => {
    const target = tui as unknown as { applyLineResets?: (lines: string[]) => string[] };
    const original = target.applyLineResets;
    if (typeof original !== "function") return false;

    const lookup = (line: string): string => {
      let out = memoNew.get(line);
      if (out !== undefined) return out;
      out = memoOld.get(line) ?? original.call(tui, [line])[0]!;
      // Pass-through result = kitty image line upstream leaves untouched; skip
      // caching so multi-MB image payloads never pin the count-bounded memo.
      if (out === line) return out;
      if (memoNew.size >= MEMO_GENERATION_LIMIT) {
        memoOld = memoNew;
        memoNew = new Map();
      }
      memoNew.set(line, out);
      return out;
    };

    const patched = (lines: string[]): string[] => {
      if (!enabled) return original.call(tui, lines);
      for (let i = 0; i < lines.length; i++) lines[i] = lookup(lines[i]!);
      return lines;
    };

    target.applyLineResets = patched;
    restoreFns.push(() => {
      if (target.applyLineResets === patched) delete target.applyLineResets;
    });
    return true;
  };

  const installWindowPatch = (tui: TUI, formatMarker: (text: string) => string): boolean => {
    const chat = findChatContainer(tui);
    if (!chat) return false;

    const warmTick = () => {
      warmTimer = undefined;
      const children = chat.children;
      const start = performance.now();
      while (warmCursor >= 0 && performance.now() - start < WARM_BUDGET_MS) {
        const child = children[warmCursor];
        if (child && !warmSet.has(child)) {
          try {
            child.render(warmWidth);
          } catch {
            // fail open: an unwarmable component just renders cold later
          }
          warmSet.add(child);
        }
        warmCursor -= 1;
      }
      if (warmCursor < 0) {
        cold = false;
        tui.requestRender();
      } else {
        warmTimer = setTimeout(warmTick, WARM_INTERVAL_MS);
        warmTimer.unref?.();
      }
    };

    // Message-aligned tail: walk components from the end, spending at most
    // ~COLD_SYNC_BUDGET_MS of synchronous parsing. The line floor guarantees a
    // few screens of immediate scrollback; the caps bound the marker window
    // and the first frame after the rebuild.
    const chooseAnchor = (children: readonly Component[], width: number): number => {
      const start = performance.now();
      let lines = 0;
      for (let i = children.length - 1; i >= 0; i--) {
        lines += children[i]!.render(width).length;
        if (lines < MIN_TAIL_LINES) continue;
        if (
          performance.now() - start >= COLD_SYNC_BUDGET_MS ||
          lines >= MAX_TAIL_LINES ||
          children.length - i >= MAX_TAIL_COMPONENTS
        ) {
          return i;
        }
      }
      return 0;
    };

    const originalRender = chat.render;
    const patchedRender = function (this: Container, width: number): string[] {
      if (!enabled) return originalRender.call(this, width);

      const children = this.children;
      let rescan = false;
      if (width !== warmWidth) {
        warmWidth = width;
        warmSet = new WeakSet();
        rescan = true;
      }
      if (children !== childrenRef) {
        // Container.clear() replaces the array; steady-state appends reuse it.
        childrenRef = children;
        rescan = true;
      } else if (children.length - observedChildCount > COLD_COMPONENT_THRESHOLD) {
        // An extension can trigger an empty render before initial messages are
        // appended to the same array. Treat a later bulk append as a rebuild.
        rescan = true;
      }
      observedChildCount = children.length;

      if (rescan) {
        stopWarm();
        let coldCount = 0;
        for (const child of children) if (!warmSet.has(child)) coldCount += 1;
        cold = coldCount > COLD_COMPONENT_THRESHOLD;
        if (cold) {
          anchorIndex = chooseAnchor(children, width);
          warmCursor = anchorIndex - 1;
          if (warmCursor < 0) {
            cold = false;
          } else {
            warmTimer = setTimeout(warmTick, WARM_INTERVAL_MS);
            warmTimer.unref?.();
          }
        }
      }

      const start = cold ? anchorIndex : 0;
      const lines: string[] = cold ? [truncateToWidth(formatMarker(HIDDEN_MARKER), width, "")] : [];
      for (let i = start; i < children.length; i++) {
        const child = children[i]!;
        for (const line of child.render(width)) lines.push(line);
        warmSet.add(child);
      }
      return lines;
    };

    chat.render = patchedRender;
    restoreFns.push(() => {
      if (chat.render === patchedRender) chat.render = originalRender;
    });
    return true;
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setWidget(WIDGET_KEY, (tui) => {
      restoreAll();
      activeTui = tui;
      const memoInstalled = installMemoPatch(tui);
      const windowInstalled = installWindowPatch(tui, (text) => ctx.ui.theme.fg("dim", text));
      if (!memoInstalled || !windowInstalled) {
        const missing = [
          memoInstalled ? undefined : "line memo",
          windowInstalled ? undefined : "rebuild window",
        ].filter(Boolean);
        ctx.ui.notify(`render-perf: ${missing.join(" + ")} disabled (unsupported pi TUI structure)`, "warning");
      }
      return emptyWidget;
    });
  });

  pi.on("session_shutdown", () => {
    restoreAll();
  });

  return {
    isEnabled: () => enabled,
    setEnabled: (value) => {
      enabled = value;
      if (!enabled) {
        stopWarm();
        cold = false;
      }
      activeTui?.requestRender();
    },
  };
}
