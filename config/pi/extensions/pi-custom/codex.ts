// codex.ts — OpenAI request tweaks: fast mode (priority service tier) for the
// openai-codex provider, and low verbosity for OpenAI Responses models.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Model = NonNullable<ExtensionContext["model"]>;

const FAST_STATUS_KEY = "pi-custom:fast";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexModel(model: Model | undefined): model is Model {
  return model?.provider === "openai-codex";
}

// ─── Registration ────────────────────────────────────────────────────────────

export interface CodexControl {
  isDesired(): boolean;
  isActive(): boolean;
  setDesired(value: boolean): void;
}

interface CodexRuntimeState {
  activeTui?: { requestRender(): void };
}

export function registerCodex(
  pi: ExtensionAPI,
  runtime: CodexRuntimeState,
  initial: { fast: boolean },
): CodexControl {
  let desired = initial.fast;
  let model: Model | undefined;
  let ui: ExtensionContext["ui"] | undefined;

  const isActive = () => desired && isCodexModel(model);
  const syncStatus = () => {
    ui?.setStatus(FAST_STATUS_KEY, isActive() ? "fast" : undefined);
    runtime.activeTui?.requestRender();
  };
  const setDesired = (value: boolean) => {
    desired = value;
    syncStatus();
  };

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    model = ctx.model;
    syncStatus();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(FAST_STATUS_KEY, undefined);
    ui = undefined;
  });

  pi.on("model_select", (event, ctx) => {
    ui = ctx.ui;
    model = event.model;
    syncStatus();
  });

  pi.on("before_provider_request", (event) => {
    if (!desired || !isCodexModel(model) || !isRecord(event.payload)) return undefined;
    return { ...event.payload, service_tier: "priority" };
  });

  // Like Codex CLI and Pi's codex transport, ask OpenAI Responses models for low verbosity.
  pi.on("before_provider_request", (event) => {
    if (model?.provider !== "openai" || model.api !== "openai-responses" || !isRecord(event.payload)) return undefined;
    const text = isRecord(event.payload.text) ? event.payload.text : {};
    if (text.verbosity !== undefined) return undefined;
    return { ...event.payload, text: { ...text, verbosity: "low" } };
  });

  return { isDesired: () => desired, isActive, setDesired };
}
