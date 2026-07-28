// codex.ts — openai-codex provider integration: fast mode (priority service
// tier) and Codex-style remote compaction over the Responses API.
//
// On compaction with an openai-codex model, the full conversation is sent to
// the codex/responses endpoint with a trailing compaction_trigger item, the
// way the Codex CLI compacts. The returned opaque `compaction` item is stored
// in the compaction entry's details and replayed — together with retained
// user messages and everything after the compaction — as the request input on
// later same-model turns. Pi's regular text summary is still generated and
// stored, so other models, forks, and tree navigation keep working unchanged.
// The conversion helpers are loaded from Pi's bundled pi-ai files because the
// extension loader aliases the pi-ai package root and does not expose its API
// subpaths through Jiti.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { compact, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@earendil-works/pi-ai";

type Model = NonNullable<ExtensionContext["model"]>;
type SessionEntry = SessionBeforeCompactEvent["branchEntries"][number];
type AgentMessage = Parameters<typeof convertToLlm>[0][number];
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
type ResponseItem = Record<string, unknown>;

const FAST_STATUS_KEY = "pi-custom:fast";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
const REMOTE_COMPACTION_PROVIDER = "openai-codex-responses";
const RETAINED_USER_TOKEN_BUDGET = 32_000;
const MAX_RESPONSES_INPUT_ITEMS = 16_384;

interface RemoteCompactionDetails {
  provider: typeof REMOTE_COMPACTION_PROVIDER;
  modelKey: string;
  replacementHistory: ResponseItem[];
  usage?: unknown;
}

interface CodexAiInternals {
  createGrammarToolInputProperties(
    tools: Tool[] | undefined,
    supportsOpenAIGrammarTools: boolean,
  ): ReadonlyMap<string, string>;
  clampOpenAIPromptCacheKey(key: string | undefined): string | undefined;
  convertResponsesMessages(
    model: Model,
    context: { messages: ReturnType<typeof convertToLlm>; tools: Tool[] },
    allowedToolCallProviders: ReadonlySet<string>,
    options: Record<string, unknown>,
  ): unknown;
  convertResponsesTools(tools: readonly Tool[], options: Record<string, unknown>): unknown[];
}

const CODEX_AI_INTERNAL_MODULES = [
  "constrained-sampling",
  "openai-prompt-cache",
  "openai-responses-shared",
] as const;

function findPiAiApiDir(startPath: string): string | undefined {
  let current = dirname(realpathSync(startPath));
  while (true) {
    const candidates = [
      join(current, "node_modules/@earendil-works/pi-ai/dist/api"),
      join(current, "lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api"),
      join(current, "libexec/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api"),
    ];
    const found = candidates.find((candidate) =>
      CODEX_AI_INTERNAL_MODULES.every((name) => existsSync(join(candidate, `${name}.js`))),
    );
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function loadCodexAiInternals(): Promise<CodexAiInternals> {
  const argvPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
  let apiDir = argvPath ? findPiAiApiDir(argvPath) : undefined;
  if (!apiDir) {
    const commandPath = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
    apiDir = findPiAiApiDir(commandPath);
  }
  if (!apiDir) throw new Error("Failed to locate pi-ai internals for Codex compaction");

  const [sampling, promptCache, responses] = await Promise.all(
    CODEX_AI_INTERNAL_MODULES.map((name) => import(pathToFileURL(join(apiDir, `${name}.js`)).href)),
  );
  return {
    createGrammarToolInputProperties: sampling.createGrammarToolInputProperties,
    clampOpenAIPromptCacheKey: promptCache.clampOpenAIPromptCacheKey,
    convertResponsesMessages: responses.convertResponsesMessages,
    convertResponsesTools: responses.convertResponsesTools,
  } as CodexAiInternals;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelKey(model: Model): string {
  return `${model.provider}/${model.id}`;
}

function isCodexModel(model: Model | undefined): model is Model {
  return model?.provider === "openai-codex";
}

// ─── Message conversion (mirrors the built-in codex transport) ───────────────

// The codex-responses compat flags are a subset of Model["compat"] union members.
type CodexCompat = { supportsStrictMode?: boolean; supportsOpenAIGrammarTools?: boolean };

function toolConversionOptions(model: Model) {
  const compat = (model.compat ?? {}) as CodexCompat;
  return {
    strict: null,
    supportsStrictMode: compat.supportsStrictMode ?? true,
    supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools ?? false,
  };
}

function toResponseItems(
  internals: CodexAiInternals,
  model: Model,
  messages: AgentMessage[],
  tools: ToolInfo[],
): ResponseItem[] {
  const aiTools = tools as unknown as Tool[];
  const options = toolConversionOptions(model);
  return internals.convertResponsesMessages(
    model,
    { messages: convertToLlm(messages), tools: aiTools },
    CODEX_TOOL_CALL_PROVIDERS,
    {
      includeSystemPrompt: false,
      grammarToolInputProperties: internals.createGrammarToolInputProperties(
        aiTools,
        options.supportsOpenAIGrammarTools,
      ),
      toolOptions: options,
    },
  ) as unknown as ResponseItem[];
}

function activeTools(pi: ExtensionAPI): ToolInfo[] {
  const active = new Set(pi.getActiveTools());
  return pi.getAllTools().filter((tool) => active.has(tool.name));
}

// ─── Replay-history reconstruction from session entries ──────────────────────

function latestRemoteCompaction(
  branch: SessionEntry[],
  key: string,
): { index: number; details: RemoteCompactionDetails } | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "compaction") continue;
    const details = isRecord(entry.details) ? entry.details.remoteCompaction : undefined;
    if (
      isRecord(details) &&
      details.provider === REMOTE_COMPACTION_PROVIDER &&
      details.modelKey === key &&
      Array.isArray(details.replacementHistory)
    ) {
      return { index, details: details as unknown as RemoteCompactionDetails };
    }
    // The newest compaction carries no matching artifact; use Pi's summary path.
    return undefined;
  }
  return undefined;
}

function branchMessages(branch: SessionEntry[], fromIndex = 0): AgentMessage[] {
  return branch
    .slice(fromIndex)
    .flatMap((entry) => (entry.type === "message" ? [entry.message as AgentMessage] : []));
}

function reconstructInput(
  internals: CodexAiInternals,
  model: Model,
  branch: SessionEntry[],
  tools: ToolInfo[],
): ResponseItem[] | undefined {
  const found = latestRemoteCompaction(branch, modelKey(model));
  if (!found) return undefined;
  return [
    ...found.details.replacementHistory,
    ...toResponseItems(internals, model, branchMessages(branch, found.index + 1), tools),
  ];
}

// ─── Retained user messages ──────────────────────────────────────────────────

function userItemTextParts(item: ResponseItem): string[] {
  if (typeof item.content === "string") return [item.content];
  if (!Array.isArray(item.content)) return [];
  return item.content.flatMap((part) =>
    isRecord(part) && part.type === "input_text" && typeof part.text === "string" ? [part.text] : [],
  );
}

function isRealUserMessage(item: ResponseItem): boolean {
  if (item.role !== "user") return false;
  if (item.type !== undefined && item.type !== "message") return false;
  return userItemTextParts(item).join("").trim().length > 0 ||
    (Array.isArray(item.content) && item.content.some((part) => isRecord(part) && part.type === "input_image"));
}

function approximateItemTokens(item: ResponseItem): number {
  return Math.max(1, Math.ceil(userItemTextParts(item).join("").length / 4));
}

function truncateUserItem(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
  let remaining = Math.max(0, maxTokens * 4);
  if (typeof item.content === "string") {
    const text = item.content.slice(0, remaining);
    return text ? { ...item, content: text } : undefined;
  }
  if (!Array.isArray(item.content)) return undefined;
  const content = item.content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (part.type === "input_image") return [part];
    if (typeof part.text !== "string" || remaining === 0) return [];
    const text = part.text.slice(0, remaining);
    remaining -= text.length;
    return text ? [{ ...part, text }] : [];
  });
  return content.length > 0 ? { ...item, content } : undefined;
}

export function retainUserMessages(
  items: ResponseItem[],
  maxTokens = RETAINED_USER_TOKEN_BUDGET,
): ResponseItem[] {
  let remaining = maxTokens;
  const retainedReversed: ResponseItem[] = [];
  for (const item of [...items].reverse()) {
    if (remaining === 0) break;
    if (!isRealUserMessage(item)) continue;
    const tokens = approximateItemTokens(item);
    if (tokens <= remaining) {
      retainedReversed.push(item);
      remaining -= tokens;
      continue;
    }
    const truncated = truncateUserItem(item, remaining);
    if (truncated) retainedReversed.push(truncated);
    remaining = 0;
  }
  return retainedReversed.reverse();
}

// ─── Remote compaction request ───────────────────────────────────────────────

export function resolveCodexUrl(baseUrl: string | undefined): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : "https://chatgpt.com/backend-api";
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function extractAccountId(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Failed to extract accountId from Codex token");
  const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  const auth = isRecord(payload) ? payload["https://api.openai.com/auth"] : undefined;
  const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("Failed to extract accountId from Codex token");
  }
  return accountId;
}

export function withCompactionFeature(configured: string | null): string {
  const features = new Set(
    (configured ?? "").split(",").map((feature) => feature.trim()).filter(Boolean),
  );
  features.add(REMOTE_COMPACTION_FEATURE);
  return [...features].join(",");
}

function buildCompactionHeaders(
  model: Model,
  apiKey: string,
  extraHeaders: Record<string, string> | undefined,
  sessionId: string,
): Headers {
  const headers = new Headers(model.headers);
  for (const [key, value] of Object.entries(extraHeaders ?? {})) headers.set(key, value);
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("chatgpt-account-id", extractAccountId(apiKey));
  headers.set("originator", "pi");
  headers.set("User-Agent", `pi (${platform()} ${release()}; ${arch()})`);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("session-id", sessionId);
  headers.set("x-client-request-id", sessionId);
  headers.set("x-codex-beta-features", withCompactionFeature(headers.get("x-codex-beta-features")));
  return headers;
}

function buildCompactionBody(internals: CodexAiInternals, params: {
  model: Model;
  input: ResponseItem[];
  instructions: string;
  tools: ToolInfo[];
  thinkingLevel: string;
  sessionId: string;
}): Record<string, unknown> {
  const { model } = params;
  const body: Record<string, unknown> = {
    model: model.id,
    store: false,
    stream: true,
    instructions: params.instructions || "You are a helpful assistant.",
    input: [...params.input, { type: "compaction_trigger" }],
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: internals.clampOpenAIPromptCacheKey(params.sessionId),
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  if (params.tools.length > 0) {
    body.tools = internals.convertResponsesTools(params.tools as unknown as Tool[], toolConversionOptions(model));
  }
  if (model.reasoning && params.thinkingLevel !== "off") {
    const mapped = model.thinkingLevelMap?.[params.thinkingLevel as never] ?? params.thinkingLevel;
    if (mapped !== null) body.reasoning = { effort: mapped, summary: "auto" };
  }
  return body;
}

function parseSseEvents(text: string): unknown[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .flatMap((block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") return [];
      try {
        return [JSON.parse(data) as unknown];
      } catch {
        return [];
      }
    });
}

export function extractCompactionResult(events: unknown[]): { item: ResponseItem; usage?: unknown } {
  let completed = false;
  let usage: unknown;
  const items: ResponseItem[] = [];
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "error") {
      const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
      throw new Error(`Codex compaction failed: ${message}`);
    }
    if (event.type === "response.failed") {
      const response = isRecord(event.response) ? event.response : undefined;
      const error = response && isRecord(response.error) ? response.error : undefined;
      throw new Error(`Codex compaction failed: ${typeof error?.message === "string" ? error.message : "response failed"}`);
    }
    if (event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "compaction") {
      items.push(event.item);
      continue;
    }
    if (event.type === "response.completed") {
      completed = true;
      usage = isRecord(event.response) ? event.response.usage : undefined;
    }
  }
  if (!completed) throw new Error("Codex compaction stream ended before completion.");
  if (items.length !== 1) {
    throw new Error(`Codex compaction expected exactly one compaction item, got ${items.length}.`);
  }
  return { item: items[0]!, usage };
}

async function requestRemoteCompaction(params: {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<{ item: ResponseItem; usage?: unknown }> {
  const response = await fetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify(params.body),
    signal: params.signal,
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 400);
    throw new Error(`Codex compaction request failed (${response.status}): ${text}`);
  }
  return extractCompactionResult(parseSseEvents(await response.text()));
}

// ─── Registration ────────────────────────────────────────────────────────────

export interface CodexControl {
  isDesired(): boolean;
  isActive(): boolean;
  setDesired(value: boolean): void;
  setCompactionEnabled(value: boolean): void;
}

interface CodexRuntimeState {
  activeTui?: { requestRender(): void };
}

export async function registerCodex(
  pi: ExtensionAPI,
  runtime: CodexRuntimeState,
  initial: { fast: boolean; compaction: boolean },
): Promise<CodexControl> {
  let internalsPromise: Promise<CodexAiInternals> | undefined;
  const getInternals = () => internalsPromise ??= loadCodexAiInternals();
  let desired = initial.fast;
  let compactionEnabled = initial.compaction;
  let model: Model | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  let warnedReplayFailure = false;

  const isActive = () => desired && isCodexModel(model);
  const syncStatus = () => {
    ui?.setStatus?.(FAST_STATUS_KEY, isActive() ? "fast" : undefined);
    runtime.activeTui?.requestRender();
  };
  const setDesired = (value: boolean) => {
    desired = value;
    syncStatus();
  };

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    model = ctx.model;
    warnedReplayFailure = false;
    syncStatus();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus?.(FAST_STATUS_KEY, undefined);
    ui = undefined;
  });

  pi.on("model_select", (event, ctx) => {
    ui = ctx.ui;
    model = event.model;
    syncStatus();
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!isCodexModel(model)) return undefined;
    if (!isRecord(event.payload)) return undefined;
    let payload = event.payload;
    let patched = false;
    if (compactionEnabled && Array.isArray(payload.input)) {
      try {
        const branch = ctx.sessionManager.getBranch();
        if (latestRemoteCompaction(branch, modelKey(model))) {
          const input = reconstructInput(await getInternals(), model, branch, activeTools(pi));
          if (input) {
            payload = { ...payload, input };
            patched = true;
          }
        }
      } catch (error) {
        // Fall back to Pi's text-summary context, which is always present.
        if (!warnedReplayFailure && ctx.hasUI) {
          warnedReplayFailure = true;
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Codex compaction replay failed; using text summary. ${message}`, "warning");
        }
      }
    }
    if (desired) {
      payload = { ...payload, service_tier: "priority" };
      patched = true;
    }
    return patched ? payload : undefined;
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!compactionEnabled) return undefined;
    const compactionModel = ctx.model;
    if (!isCodexModel(compactionModel)) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(compactionModel);
    if (!auth.ok || !auth.apiKey) return undefined;

    let internals: CodexAiInternals;
    try {
      internals = await getInternals();
    } catch (error) {
      if (!warnedReplayFailure && ctx.hasUI) {
        warnedReplayFailure = true;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Codex compaction unavailable; using text summary. ${message}`, "warning");
      }
      return undefined;
    }

    const tools = activeTools(pi);
    const branch = event.branchEntries;
    const activeMessages = ctx.sessionManager.buildSessionContext().messages as AgentMessage[];
    const input =
      reconstructInput(internals, compactionModel, branch, tools) ??
      toResponseItems(internals, compactionModel, activeMessages, tools);
    const sessionId = ctx.sessionManager.getSessionId();

    // Built before starting any promise: a synchronous throw here (e.g. a
    // non-JWT token in extractAccountId) must not orphan an already-started
    // compact() whose later rejection would be unhandled.
    const remoteRequest = {
      url: resolveCodexUrl(compactionModel.baseUrl),
      headers: buildCompactionHeaders(compactionModel, auth.apiKey, auth.headers, sessionId),
      body: buildCompactionBody(internals, {
        model: compactionModel,
        input,
        instructions: ctx.getSystemPrompt(),
        tools,
        thinkingLevel: pi.getThinkingLevel(),
        sessionId,
      }),
      signal: event.signal,
    };
    const remotePromise = input.length + 1 <= MAX_RESPONSES_INPUT_ITEMS
      ? requestRemoteCompaction(remoteRequest)
      : Promise.reject(new Error(
        `Codex compaction input has ${input.length + 1} items; maximum is ${MAX_RESPONSES_INPUT_ITEMS}`,
      ));

    const [local, remote] = await Promise.allSettled([
      compact(
        event.preparation,
        compactionModel,
        auth.apiKey,
        auth.headers,
        event.customInstructions,
        event.signal,
        pi.getThinkingLevel(),
        undefined,
        auth.env,
      ),
      remotePromise,
    ]);

    if (remote.status !== "fulfilled") {
      if (!event.signal.aborted && ctx.hasUI) {
        const message = remote.reason instanceof Error ? remote.reason.message : String(remote.reason);
        ctx.ui.notify(`Codex remote compaction failed; keeping text summary only. ${message}`, "warning");
      }
      return local.status === "fulfilled" ? { compaction: local.value } : undefined;
    }

    const remoteDetails: RemoteCompactionDetails = {
      provider: REMOTE_COMPACTION_PROVIDER,
      modelKey: modelKey(compactionModel),
      replacementHistory: [...retainUserMessages(input), remote.value.item],
      ...(remote.value.usage !== undefined ? { usage: remote.value.usage } : {}),
    };
    const localResult = local.status === "fulfilled" ? local.value : undefined;
    return {
      compaction: {
        summary:
          localResult?.summary ??
          `Conversation compacted into an opaque ${compactionModel.id} artifact; no portable text summary is available.`,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        ...(localResult?.usage ? { usage: localResult.usage } : {}),
        details: {
          ...(isRecord(localResult?.details) ? localResult.details : {}),
          remoteCompaction: remoteDetails,
        },
      },
    };
  });

  return {
    isDesired: () => desired,
    isActive,
    setDesired,
    setCompactionEnabled: (value) => {
      compactionEnabled = value;
    },
  };
}
