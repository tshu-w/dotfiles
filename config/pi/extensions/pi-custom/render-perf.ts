// Transcript render performance for long sessions — private-API workaround for
// pi 0.80.6+ (upstream issue earendil-works/pi#6478). Instance-level and
// fail-open:
//
// applyLineResets memoization. Upstream rebuilds every line string on every
// frame (normalize + reset suffix), which defeats the pointer-equality fast
// path in the frame diff and makes typing latency grow with transcript
// length. A bounded two-generation memo returns stable string references,
// so steady-state frames drop to pointer work. Scrollback stays complete.
//
// The former cold-rebuild windowing patch is gone: on pi 0.81.1 a full cold
// rebuild of realistic transcripts measures 50–150ms, and its deferred full
// reveal caused a visible top-to-bottom repaint of the terminal.
//
// Controlled through the pi-custom settings panel.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-custom-render-perf";
const MEMO_GENERATION_LIMIT = 65_536;

const emptyWidget: Component = {
  render: () => [],
  invalidate: () => {},
};

export interface RenderPerfControl {
  isEnabled(): boolean;
  setEnabled(value: boolean): void;
}

export function registerRenderPerf(pi: ExtensionAPI, initiallyEnabled = true): RenderPerfControl {
  let enabled = initiallyEnabled;
  let restoreFns: Array<() => void> = [];
  let activeTui: TUI | undefined;

  let memoNew = new Map<string, string>();
  let memoOld = new Map<string, string>();

  const restoreAll = () => {
    for (const restore of restoreFns) restore();
    restoreFns = [];
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

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setWidget(WIDGET_KEY, (tui) => {
      restoreAll();
      activeTui = tui;
      if (!installMemoPatch(tui)) {
        ctx.ui.notify("render-perf: line memo disabled (unsupported pi TUI structure)", "warning");
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
      activeTui?.requestRender();
    },
  };
}
