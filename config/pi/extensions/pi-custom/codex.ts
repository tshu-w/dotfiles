// codex.ts — openai-codex provider integration: fast mode (priority service
// tier) and Codex-style remote compaction over the Responses API.
//
// On compaction with an openai-codex model, the conversation is sent to the
// codex/responses endpoint with a trailing compaction_trigger item, the way
// the Codex CLI compacts. Tool outputs are rewritten when needed to keep an
// already-oversized request within the model context window. The returned
// opaque `compaction` item is stored in the compaction entry's details and
// replayed — together with retained user messages and everything after the
// compaction — as the request input on later same-model turns. Pi's regular
// text summary is still generated and stored, so other models, forks, and tree
// navigation keep working unchanged. While a tape Anchor is active, tape owns
// the compaction hook and supplies its projected context through a temporary
// versioned, session-scoped bridge so both artifacts summarize the same history.
// A newer Anchor also supersedes replay of any older Codex artifact.
// The conversion helpers are loaded from Pi's bundled pi-ai files because the
// extension loader aliases the pi-ai package root and does not expose its API
// subpaths through Jiti.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { compact, convertToLlm } from "@earendil-works/pi-coding-agent";
import { calculateCost, type Tool, type Usage } from "@earendil-works/pi-ai";

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
const CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE =
  "Output exceeded the available model context and was truncated";
const PROJECTED_COMPACTION_BRIDGE_SYMBOL = Symbol.for("pi-tape.projected-compaction.v1");

interface RemoteCompactionDetails {
  provider: typeof REMOTE_COMPACTION_PROVIDER;
  modelKey: string;
  replacementHistory: ResponseItem[];
  usage?: unknown;
}

interface ProjectedCompactionBridgeInput {
  event: SessionBeforeCompactEvent;
  context: ExtensionContext;
  preparation: SessionBeforeCompactEvent["preparation"];
  messages: AgentMessage[];
}

interface ProjectedCompactionAdapter {
  compact(input: ProjectedCompactionBridgeInput): Promise<{ compaction: CompactionResult } | undefined>;
}

interface ProjectedCompactionBridge extends ProjectedCompactionAdapter {
  adapters: Map<ExtensionContext["sessionManager"], ProjectedCompactionAdapter>;
}

// Keep the shared dispatcher outside registerCodex so it cannot retain its first runtime.
async function dispatchProjectedCompaction(
  this: ProjectedCompactionBridge,
  input: ProjectedCompactionBridgeInput,
) {
  return this.adapters.get(input.context.sessionManager)?.compact(input);
}

interface CodexAiInternals {
  createGrammarToolInputProperties(
    tools: Tool[] | undefined,
    supportsOpenAIGrammarTools: boolean,
  ): ReadonlyMap<string, string>;
  clampOpenAIPromptCacheKey(key: string | undefined): string | undefined;
  convertResponsesMessages(
    model: Model,
    context: { messages: ReturnType<typeof convertToLlm> },
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
type CodexCompat = {
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  supportsMidConvoSystemMessages?: boolean;
  supportsAdditionalTools?: boolean;
  supportsToolSearch?: boolean;
};

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
  replay = false,
): ResponseItem[] {
  const aiTools = tools as unknown as Tool[];
  const compat = (model.compat ?? {}) as CodexCompat;
  const options = toolConversionOptions(model);
  return internals.convertResponsesMessages(
    model,
    { messages: convertToLlm(messages) },
    CODEX_TOOL_CALL_PROVIDERS,
    {
      includeSystemPrompt: false,
      supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages ?? false,
      // Replay keeps native in-place declarations; compaction sends active tools at the top level.
      supportsAdditionalTools: replay && (compat.supportsAdditionalTools ?? false),
      supportsToolSearch: replay && (compat.supportsToolSearch ?? false),
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

function hasActiveTapeAnchor(branch: SessionEntry[]): boolean {
  let active = false;
  for (const entry of branch) {
    if (entry?.type === "compaction") {
      active = false;
      continue;
    }
    if (entry?.type !== "message") continue;
    const message = entry.message as AgentMessage & { details?: unknown; toolName?: string };
    const details = isRecord(message.details) ? message.details.tapeAnchor : undefined;
    if (
      message.role === "toolResult" &&
      message.toolName === "tape" &&
      isRecord(details) &&
      details.version === 1 &&
      typeof details.name === "string" &&
      typeof details.summary === "string"
    ) {
      active = true;
    }
  }
  return active;
}

function reconstructInput(
  internals: CodexAiInternals,
  model: Model,
  branch: SessionEntry[],
  tools: ToolInfo[],
  replay = false,
): ResponseItem[] | undefined {
  const found = latestRemoteCompaction(branch, modelKey(model));
  if (!found) return undefined;
  const entry = branch[found.index];
  // Seed conversion with the checkpoint so the first post-compaction system
  // delta is not mistaken for the leading prompt carried in instructions.
  const checkpoint = entry?.type === "compaction" ? entry.systemMessage : undefined;
  return [
    ...found.details.replacementHistory,
    ...toResponseItems(internals, model, [
      checkpoint ?? { role: "system", content: "", timestamp: 0 },
      ...branchMessages(branch, found.index + 1),
    ], tools, replay),
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

function truncateUtf16Prefix(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const prefix = value.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

function truncateUserItem(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
  let remaining = Math.max(0, maxTokens * 4);
  if (typeof item.content === "string") {
    const text = truncateUtf16Prefix(item.content, remaining);
    return text ? { ...item, content: text } : undefined;
  }
  if (!Array.isArray(item.content)) return undefined;
  const content = item.content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (part.type === "input_image") return [part];
    if (typeof part.text !== "string" || remaining === 0) return [];
    const text = truncateUtf16Prefix(part.text, remaining);
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

function approximateResponseItemTokens(item: ResponseItem): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(item), "utf8") / 4));
}

function rewriteToolOutput(item: ResponseItem): ResponseItem | undefined {
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    if (item.output === CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE) return undefined;
    return { ...item, output: CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE };
  }
  if (item.type === "tool_search_output" && Array.isArray(item.tools) && item.tools.length > 0) {
    return { ...item, tools: [] };
  }
  return undefined;
}

function trimCompactionInput(
  items: ResponseItem[],
  tokensBefore: number,
  maxTokens: number,
): ResponseItem[] {
  if (tokensBefore <= maxTokens) return items;
  let estimatedTokens = tokensBefore;
  let trimmed = items;
  // Pi compacts after the final response, so search past non-tool items that
  // the inline Codex loop would not have appended yet.
  for (let index = items.length - 1; index >= 0 && estimatedTokens > maxTokens; index--) {
    const item = items[index]!;
    const rewritten = rewriteToolOutput(item);
    if (!rewritten) continue;
    const removedTokens = approximateResponseItemTokens(item) - approximateResponseItemTokens(rewritten);
    if (removedTokens <= 0) continue;
    if (trimmed === items) trimmed = [...items];
    trimmed[index] = rewritten;
    estimatedTokens -= removedTokens;
  }
  return trimmed;
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

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

function compactionUsage(model: Model, remote: ResponsesUsage | undefined, local: Usage | undefined): Usage | undefined {
  if (!remote) return local;
  const cacheRead = remote.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = remote.input_tokens_details?.cache_write_tokens ?? 0;
  const usage: Usage = {
    input: Math.max(0, (remote.input_tokens ?? 0) - cacheRead - cacheWrite),
    output: remote.output_tokens ?? 0,
    cacheRead,
    cacheWrite,
    reasoning: remote.output_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: remote.total_tokens ?? (remote.input_tokens ?? 0) + (remote.output_tokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  // Price each request separately before combining, preserving model cost tiers.
  calculateCost(model, usage);
  if (local) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      usage[key] += local[key];
    }
    usage.reasoning = (usage.reasoning ?? 0) + (local.reasoning ?? 0);
    if (local.cacheWrite1h !== undefined) usage.cacheWrite1h = local.cacheWrite1h;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      usage.cost[key] += local.cost[key];
    }
  }
  return usage;
}

export function extractCompactionResult(events: unknown[]): { item: ResponseItem; usage?: ResponsesUsage } {
  let completed = false;
  let usage: ResponsesUsage | undefined;
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
      usage = isRecord(event.response) ? event.response.usage as ResponsesUsage | undefined : undefined;
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
}): Promise<{ item: ResponseItem; usage?: ResponsesUsage }> {
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
        if (!hasActiveTapeAnchor(branch) && latestRemoteCompaction(branch, modelKey(model))) {
          const input = reconstructInput(await getInternals(), model, branch, activeTools(pi), true);
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

  const compactCodex = async (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    preparation: SessionBeforeCompactEvent["preparation"],
    projectedMessages?: AgentMessage[],
  ) => {
    if (!compactionEnabled) return undefined;
    if (event.reason === "overflow" && event.willRetry) return undefined;
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
    const activeMessages = projectedMessages ?? ctx.sessionManager.buildSessionContext().messages as AgentMessage[];
    const input = projectedMessages
      ? toResponseItems(internals, compactionModel, activeMessages, tools)
      : reconstructInput(internals, compactionModel, branch, tools) ??
        toResponseItems(internals, compactionModel, activeMessages, tools);
    const maxInputTokens = Math.max(
      0,
      compactionModel.contextWindow - preparation.settings.reserveTokens,
    );
    const remoteInput = trimCompactionInput(input, preparation.tokensBefore, maxInputTokens);
    const sessionId = ctx.sessionManager.getSessionId();

    // Built before starting any promise: a synchronous throw here (e.g. a
    // non-JWT token in extractAccountId) must not orphan an already-started
    // compact() whose later rejection would be unhandled.
    const remoteRequest = {
      url: resolveCodexUrl(auth.baseUrl ?? compactionModel.baseUrl),
      headers: buildCompactionHeaders(compactionModel, auth.apiKey, auth.headers, sessionId),
      body: buildCompactionBody(internals, {
        model: compactionModel,
        input: remoteInput,
        instructions: ctx.getSystemPrompt(),
        tools,
        thinkingLevel: pi.getThinkingLevel(),
        sessionId,
      }),
      signal: event.signal,
    };
    const remotePromise = remoteInput.length + 1 <= MAX_RESPONSES_INPUT_ITEMS
      ? requestRemoteCompaction(remoteRequest)
      : Promise.reject(new Error(
        `Codex compaction input has ${remoteInput.length + 1} items; maximum is ${MAX_RESPONSES_INPUT_ITEMS}`,
      ));

    const [local, remote] = await Promise.allSettled([
      compact(
        preparation,
        compactionModel,
        auth.apiKey,
        auth.headers,
        event.customInstructions,
        event.signal,
        pi.getThinkingLevel(),
        ctx.modelRegistry.streamSimple.bind(ctx.modelRegistry),
        auth.env,
      ),
      remotePromise,
    ]);

    if (remote.status !== "fulfilled") {
      const message = remote.reason instanceof Error ? remote.reason.message : String(remote.reason);
      if (!event.signal.aborted && ctx.hasUI) {
        ctx.ui.notify(`Codex remote compaction failed; keeping text summary only. ${message}`, "warning");
      }
      if (local.status !== "fulfilled") return undefined;
      return {
        compaction: {
          ...local.value,
          details: {
            ...(isRecord(local.value.details) ? local.value.details : {}),
            remoteCompactionError: {
              provider: REMOTE_COMPACTION_PROVIDER,
              modelKey: modelKey(compactionModel),
              message,
            },
          },
        },
      };
    }

    const remoteDetails: RemoteCompactionDetails = {
      provider: REMOTE_COMPACTION_PROVIDER,
      modelKey: modelKey(compactionModel),
      replacementHistory: [...retainUserMessages(remoteInput), remote.value.item],
      ...(remote.value.usage !== undefined ? { usage: remote.value.usage } : {}),
    };
    const localResult = local.status === "fulfilled" ? local.value : undefined;
    const usage = compactionUsage(compactionModel, remote.value.usage, localResult?.usage);
    return {
      compaction: {
        summary:
          localResult?.summary ??
          `Conversation compacted into an opaque ${compactionModel.id} artifact; no portable text summary is available.`,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        ...(usage ? { usage } : {}),
        details: {
          ...(isRecord(localResult?.details) ? localResult.details : {}),
          remoteCompaction: remoteDetails,
        },
      },
    };
  };

  // Temporary bridge until Pi exposes the effective compaction context to
  // extensions. Tape owns active-anchor compaction and passes that projection
  // here so the text summary and Codex artifact are built from the same input.
  const projectedCompactionBridge: ProjectedCompactionAdapter = {
    compact: ({ event, context, preparation, messages }) =>
      compactCodex(event, context, preparation, messages),
  };
  const shared = globalThis as typeof globalThis & {
    [PROJECTED_COMPACTION_BRIDGE_SYMBOL]?: ProjectedCompactionBridge;
  };
  pi.on("session_start", (_event, ctx) => {
    const bridge = shared[PROJECTED_COMPACTION_BRIDGE_SYMBOL] ??= {
      adapters: new Map(),
      compact: dispatchProjectedCompaction,
    };
    bridge.adapters.set(ctx.sessionManager, projectedCompactionBridge);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const bridge = shared[PROJECTED_COMPACTION_BRIDGE_SYMBOL];
    if (bridge?.adapters.get(ctx.sessionManager) !== projectedCompactionBridge) return;
    bridge.adapters.delete(ctx.sessionManager);
    if (bridge.adapters.size === 0) delete shared[PROJECTED_COMPACTION_BRIDGE_SYMBOL];
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (hasActiveTapeAnchor(event.branchEntries)) return undefined;
    return compactCodex(event, ctx, event.preparation);
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
