import type { BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-openai-fast";
const PRIORITY_SERVICE_TIER = "priority";
const SUPPORTED_MODELS = new Set([
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
]);

type ModelIdentity = {
  provider?: string;
  id?: string;
};

let desiredActive = false;
let currentModel: ModelIdentity | undefined;
let currentUi: ExtensionContext["ui"] | undefined;

function modelKey(model: ModelIdentity | undefined): string | undefined {
  if (!model?.provider || !model.id) return undefined;
  return `${model.provider}/${model.id}`;
}

function isSupportedModel(model: ModelIdentity | undefined): boolean {
  const key = modelKey(model);
  return key !== undefined && SUPPORTED_MODELS.has(key);
}

function isFastActive(): boolean {
  return desiredActive && isSupportedModel(currentModel);
}

function syncStatus(ui = currentUi): void {
  ui?.setStatus?.(STATUS_KEY, isFastActive() ? "fast" : undefined);
}

function injectPriorityServiceTier(event: BeforeProviderRequestEvent): unknown | undefined {
  if (!isFastActive()) return undefined;
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) return undefined;
  return { ...event.payload, service_tier: PRIORITY_SERVICE_TIER };
}

export default function openaiFast(pi: ExtensionAPI) {
  pi.registerCommand("fast", {
    description: "Toggle OpenAI priority service tier",
    handler: async (args, ctx) => {
      currentUi = ctx.ui;
      currentModel = ctx.model;

      const action = args.trim().toLowerCase();
      if (action === "on" || action === "enable") desiredActive = true;
      else if (action === "off" || action === "disable") desiredActive = false;
      else if (action === "status") {
        const state = isFastActive() ? "active" : desiredActive ? "requested, unsupported model" : "off";
        ctx.ui.notify(`Fast Mode: ${state}`, "info");
        syncStatus(ctx.ui);
        return;
      } else desiredActive = !desiredActive;

      syncStatus(ctx.ui);
      const state = isFastActive() ? "on" : desiredActive ? "requested, but current model is unsupported" : "off";
      ctx.ui.notify(`Fast Mode: ${state}`, desiredActive && !isFastActive() ? "warning" : "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    currentUi = ctx.ui;
    currentModel = ctx.model;
    syncStatus(ctx.ui);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus?.(STATUS_KEY, undefined);
    currentUi = undefined;
  });

  pi.on("model_select", (event, ctx) => {
    currentUi = ctx.ui;
    currentModel = event.model;
    syncStatus(ctx.ui);
  });

  pi.on("before_provider_request", (event) => injectPriorityServiceTier(event));
}
