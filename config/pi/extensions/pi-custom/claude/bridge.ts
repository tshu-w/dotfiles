import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { query, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { createSession, getSessionPath } from "cc-session-io";
import {
  calculateCost, createAssistantMessageEventStream, getCurrentSystemMessage, getSystemMessageText, getCurrentTools,
  type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { convertPiMessages } from "./convert.js";
import { createToolServer } from "./mcp-server.js";
import { makePromptStream, userMessage, type PromptStream } from "./prompt-stream.js";
import { toolResultToMcpContent, type McpResult } from "./extract-tool-results.js";
import { buildClaudeSystemPrompt } from "./system-prompt.js";

export interface ClaudeSession {
  piSessionId: string;
  sessionId: string;
  cwd: string;
  prefix: string[];
  lastUuid?: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Exclude timestamps, usage and provider-specific response metadata from continuity checks.
function hashes(messages: any[]): string[] {
  return messages.filter((m) => m.role !== "system").map((m) => digest({
    role: m.role,
    toolCallId: m.toolCallId,
    isError: m.isError,
    content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map((b: any) => {
      switch (b.type) {
        case "text": return { type: b.type, text: b.text };
        case "thinking": return { type: b.type, thinking: b.thinking, thinkingSignature: b.thinkingSignature, redacted: b.redacted };
        case "toolCall": return { type: b.type, id: b.id, name: b.name, arguments: b.arguments };
        case "image": return { type: b.type, data: b.data, mimeType: b.mimeType };
        default: return b;
      }
    }),
  }));
}

function startsWith(history: string[], prefix: string[]): boolean {
  return history.length >= prefix.length && prefix.every((item, index) => history[index] === item);
}

function outputFor(model: Model<any>): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: "pending", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

interface RunningQuery {
  query?: Query;
  input: PromptStream;
  stream?: AssistantMessageEventStream;
  output: AssistantMessage;
  model: Model<any>;
  history: any[];
  configuration: string;
  ids: Set<string>;
  handlers: Map<string, (result: McpResult) => void>;
  results: Map<string, McpResult>;
  blocks: Map<number, { index: number; json: string }>;
  sessionId?: string;
  lastUuid?: string;
  main: boolean;
  cwd: string;
  stopped: boolean;
  sawMessage: boolean;
  removeAbort?: () => void;
}

export function createClaudeBridge(options: {
  cwd: () => string;
  sessionId: () => string;
  save: (state: ClaudeSession) => void;
  query?: typeof query;
  trace?: (message: string) => void;
}) {
  const runQuery = options.query ?? query;
  const running = new Set<RunningQuery>();
  let saved: ClaudeSession | undefined;
  let disposed = false;
  let generation = 0;

  function terminal(q: RunningQuery, reason: AssistantMessage["stopReason"], error?: string) {
    if (!q.stream) return;
    q.output.stopReason = reason;
    if (error) q.output.errorMessage = error;
    if (reason === "error" || reason === "aborted") {
      q.stream.push({ type: "error", reason, error: q.output });
    } else {
      q.stream.push({ type: "done", reason: reason as "stop" | "length" | "toolUse", message: q.output });
    }
    q.stream.end();
    q.stream = undefined;
  }

  function release(q: RunningQuery, reason: string) {
    q.input.fail(new Error(reason));
    for (const resolve of q.handlers.values()) resolve({ content: [{ type: "text", text: reason }], isError: true });
    q.handlers.clear();
    q.results.clear();
    q.removeAbort?.();
    q.query?.close();
    running.delete(q);
  }

  function stop(q: RunningQuery, error: Error, aborted = false) {
    if (q.stopped) return;
    q.stopped = true;
    if (q.main) saved = undefined;
    terminal(q, aborted ? "aborted" : "error", error.message);
    release(q, error.message);
  }

  function attach(q: RunningQuery, stream: AssistantMessageEventStream, signal?: AbortSignal) {
    q.removeAbort?.();
    q.output = outputFor(q.model);
    q.stream = stream;
    q.blocks.clear();
    q.sawMessage = false;
    stream.push({ type: "start", partial: q.output });
    const abort = () => stop(q, new Error("Claude Code request aborted"), true);
    signal?.addEventListener("abort", abort, { once: true });
    q.removeAbort = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) abort();
  }

  function usage(q: RunningQuery, value: any) {
    if (!value) return;
    const u = q.output.usage;
    if (value.input_tokens !== undefined) u.input = value.input_tokens;
    if (value.output_tokens !== undefined) u.output = value.output_tokens;
    if (value.cache_read_input_tokens !== undefined) u.cacheRead = value.cache_read_input_tokens;
    if (value.cache_creation_input_tokens !== undefined) u.cacheWrite = value.cache_creation_input_tokens;
    if (value.cache_creation?.ephemeral_1h_input_tokens !== undefined) u.cacheWrite1h = value.cache_creation.ephemeral_1h_input_tokens;
    u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
    calculateCost(q.model, u);
  }

  function streamEvent(q: RunningQuery, event: any, names: Map<string, string>) {
    if (!q.stream) return;
    if (event.type === "message_start") {
      q.sawMessage = true;
      q.output.responseId = event.message.id;
      q.output.responseModel = event.message.model;
      usage(q, event.message.usage);
    } else if (event.type === "content_block_start") {
      const b = event.content_block;
      let block: any;
      let kind: "text" | "thinking" | "toolcall";
      if (b.type === "text") { block = { type: "text", text: b.text ?? "" }; kind = "text"; }
      else if (b.type === "thinking") { block = { type: "thinking", thinking: b.thinking ?? "", thinkingSignature: b.signature ?? "" }; kind = "thinking"; }
      else if (b.type === "redacted_thinking") { block = { type: "thinking", thinking: "", thinkingSignature: b.data, redacted: true }; kind = "thinking"; }
      else if (b.type === "tool_use") {
        const name = names.get(b.name);
        if (!name) throw new Error(`Claude Code requested an unregistered tool: ${b.name}`);
        block = { type: "toolCall", id: b.id, name, arguments: b.input ?? {} };
        q.ids.add(b.id);
        kind = "toolcall";
      } else throw new Error(`Unsupported Claude content block: ${b.type}`);
      const index = q.output.content.push(block) - 1;
      q.blocks.set(event.index, { index, json: "" });
      q.stream.push({ type: `${kind}_start`, contentIndex: index, partial: q.output } as any);
    } else if (event.type === "content_block_delta") {
      const entry = q.blocks.get(event.index);
      if (!entry) throw new Error(`Missing Claude content block ${event.index}`);
      const block = q.output.content[entry.index] as any;
      const delta = event.delta;
      if (delta.type === "signature_delta") { block.thinkingSignature += delta.signature; return; }
      let kind: string;
      let text: string;
      if (delta.type === "text_delta") { kind = "text"; text = delta.text; block.text += text; }
      else if (delta.type === "thinking_delta") { kind = "thinking"; text = delta.thinking; block.thinking += text; }
      else if (delta.type === "input_json_delta") { kind = "toolcall"; text = delta.partial_json; entry.json += text; }
      else throw new Error(`Unsupported Claude content delta: ${delta.type}`);
      q.stream.push({ type: `${kind}_delta`, contentIndex: entry.index, delta: text, partial: q.output } as any);
    } else if (event.type === "content_block_stop") {
      const entry = q.blocks.get(event.index)!;
      const block = q.output.content[entry.index];
      if (block.type === "toolCall") {
        if (entry.json) block.arguments = JSON.parse(entry.json);
        q.stream.push({ type: "toolcall_end", contentIndex: entry.index, toolCall: block, partial: q.output });
      } else if (block.type === "text") q.stream.push({ type: "text_end", contentIndex: entry.index, content: block.text, partial: q.output });
      else if (block.type === "thinking") q.stream.push({ type: "thinking_end", contentIndex: entry.index, content: block.thinking, partial: q.output });
    } else if (event.type === "message_delta") {
      usage(q, event.usage);
      const reason = event.delta?.stop_reason;
      if (reason) q.output.stopReason = reason === "tool_use" ? "toolUse" : reason === "max_tokens" ? "length" : "stop";
    } else if (event.type === "message_stop" && q.output.content.some((b) => b.type === "toolCall")) {
      q.history.push(structuredClone(q.output));
      terminal(q, "toolUse");
    }
  }

  async function consume(q: RunningQuery, names: Map<string, string>) {
    try {
      for await (const message of q.query!) {
        if (q.stopped) return;
        if (message.type === "system" && message.subtype === "init") q.sessionId = message.session_id;
        if (message.type === "assistant") {
          q.lastUuid = message.uuid;
          if (message.error) {
            const detail = message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
            throw new Error(`Claude Code: ${message.error}${detail ? `\n${detail}` : ""}`);
          }
          // Completed assistant records echo the stream; they must never duplicate tool calls.
        }
        if (message.type === "stream_event" && !message.parent_tool_use_id) streamEvent(q, message.event, names);
        if (message.type === "result") {
          if (message.subtype !== "success" || message.is_error) {
            throw new Error(message.subtype === "success" ? message.result : message.errors.join("\n"));
          }
          if (!q.stream || !q.sawMessage) throw new Error("Claude Code finished without a complete streamed response");
          q.history.push(structuredClone(q.output));
          if (q.main && q.sessionId && !disposed) {
            saved = { piSessionId: options.sessionId(), sessionId: q.sessionId, cwd: q.cwd, prefix: hashes(q.history), lastUuid: q.lastUuid };
            options.save(saved);
          }
          options.trace?.(`completed cacheRead=${q.output.usage.cacheRead} cacheWrite=${q.output.usage.cacheWrite} input=${q.output.usage.input}`);
          q.stopped = true;
          release(q, "Claude Code query completed");
          terminal(q, q.output.stopReason === "length" ? "length" : "stop");
          return;
        }
      }
      if (!q.stopped) throw new Error("Claude Code stream ended without a result");
    } catch (error) {
      stop(q, error instanceof Error ? error : new Error(String(error)));
    }
  }

  async function start(model: Model<any>, context: TranscriptContext, request: SimpleStreamOptions, stream: AssistantMessageEventStream) {
    if (disposed) throw new Error("Claude Code provider has been shut down");
    request.signal?.throwIfAborted();
    if (request.fetch) throw new Error("Claude Code uses an SDK subprocess and cannot accept a custom fetch");
    const system = getCurrentSystemMessage(context.messages);
    const originalPrompt = system ? getSystemMessageText(system) : "";
    const payload = {
      messages: context.messages.filter((m) => m.role !== "system"),
      tools: request.toolChoice === "none" ? [] : getCurrentTools(context.messages),
      systemPrompt: originalPrompt,
      reasoning: request.reasoning,
      maxTokens: request.maxTokens ?? model.maxTokens,
    };
    const startedGeneration = generation;
    const effective = (await request.onPayload?.(payload, model) ?? payload) as typeof payload;
    request.signal?.throwIfAborted();
    if (disposed || generation !== startedGeneration) throw new Error("Pi session context changed before the request started");
    const { messages, reasoning, maxTokens } = effective;
    const tools = effective.tools.slice().sort((a, b) => a.name.localeCompare(b.name));
    const names = new Map(tools.map((tool) => [`mcp__pi__${tool.name}`, tool.name]));
    const systemPrompt = effective.systemPrompt === originalPrompt
      ? buildClaudeSystemPrompt(system, names)
      : effective.systemPrompt;
    const configuration = digest([model.id, systemPrompt, tools, reasoning, maxTokens, request.thinkingBudgets, request.env, request.headers, request.cacheRetention]);
    const incoming = hashes(messages);
    const resultIds = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
    const owner = [...running].find((q) => !q.stream && [...q.ids].some((id) => resultIds.has(id)));
    if (owner && owner.configuration === configuration && startsWith(incoming, hashes(owner.history))) {
      const delta = messages.slice(owner.history.length);
      const results = delta.filter((m) => m.role === "toolResult");
      if (!results.length || [...owner.ids].some((id) => !results.some((m) => m.toolCallId === id))) {
        const error = new Error("Claude Code continuation is missing tool results");
        stop(owner, error);
        throw error;
      }
      attach(owner, stream, request.signal);
      if (owner.stopped) return;
      owner.history = structuredClone(messages);
      // The stdin write must precede releasing MCP results, so steering reaches this turn.
      for (const message of delta) if (message.role === "user") {
        const { anthropicMessages } = convertPiMessages([message]);
        await owner.input.push(userMessage(anthropicMessages[0].content as any, "next"));
      }
      owner.ids.clear();
      for (const message of results) {
        const result = { content: toolResultToMcpContent(message.content), isError: message.isError };
        const resolve = owner.handlers.get(message.toolCallId);
        if (resolve) { owner.handlers.delete(message.toolCallId); resolve(result); }
        else owner.results.set(message.toolCallId, result);
      }
      return;
    }
    if (owner) stop(owner, new Error("Pi context changed; rebuilding Claude Code context"));

    const main = request.sessionId === options.sessionId() && ![...running].some((q) => q.main);
    const cwd = options.cwd();
    let promptMessages = messages;
    let resume: string | undefined;
    let resumeSessionAt: string | undefined;
    if (main && saved && saved.piSessionId === options.sessionId() && saved.cwd === cwd
      && startsWith(incoming, saved.prefix) && messages.slice(saved.prefix.length).every((m) => m.role === "user")
      && existsSync(getSessionPath(saved.sessionId, cwd, request.env?.CLAUDE_CONFIG_DIR))) {
      promptMessages = messages.slice(saved.prefix.length);
      resume = saved.sessionId;
      resumeSessionAt = saved.lastUuid;
      options.trace?.("resume: unchanged history");
    } else {
      // Import only into a new, bridge-owned session. Never overwrite another session's history.
      const split = messages.findLastIndex((m) => m.role !== "user") + 1;
      const history = messages.slice(0, split);
      promptMessages = messages.slice(split);
      if (history.length) {
        const session = createSession({ projectPath: cwd, model: model.id, claudeDir: request.env?.CLAUDE_CONFIG_DIR });
        const { anthropicMessages } = convertPiMessages(history);
        session.importMessages(anthropicMessages);
        session.save();
        resume = session.sessionId;
      }
      options.trace?.(history.length ? "rebuild: Pi history changed or no saved session" : "start: empty history");
    }
    const { anthropicMessages } = convertPiMessages(promptMessages);
    if (anthropicMessages.some((m) => m.role !== "user")) throw new Error("Claude Code resume suffix contains non-user history");
    const prompt = anthropicMessages.flatMap((m) => typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content);
    const input = makePromptStream();
    const q: RunningQuery = {
      input, output: outputFor(model), model, history: structuredClone(messages), configuration,
      ids: new Set(), handlers: new Map(), results: new Map(), blocks: new Map(),
      cwd, main, stopped: false, sawMessage: false, sessionId: resume,
    };
    running.add(q);
    attach(q, stream, request.signal);
    if (q.stopped) return;
    const server = createToolServer("pi", tools.map((tool) => ({
      name: tool.name, description: tool.description, inputSchema: tool.parameters,
      handler: async (id) => {
        if (q.stopped) return { content: [{ type: "text", text: "Pi request ended" }], isError: true };
        const result = q.results.get(id);
        if (result) { q.results.delete(id); return result; }
        return new Promise<McpResult>((resolve) => { q.handlers.set(id, resolve); });
      },
    })));
    const mappedEffort = reasoning
      ? model.thinkingLevelMap?.[reasoning] ?? (reasoning === "minimal" ? "low" : reasoning)
      : undefined;
    const adaptive = model.compat && "forceAdaptiveThinking" in model.compat && model.compat.forceAdaptiveThinking;
    let thinking: Options["thinking"] = { type: "disabled" };
    let outputTokens = maxTokens;
    if (reasoning) {
      if (adaptive) thinking = { type: "adaptive" };
      else {
        const level = reasoning === "xhigh" || reasoning === "max" ? "high" : reasoning;
        const budget = Math.max(1024, request.thinkingBudgets?.[level] ?? { minimal: 1024, low: 2048, medium: 8192, high: 16384 }[level]);
        outputTokens = Math.min(model.maxTokens, Math.max(maxTokens, 1024) + budget);
        thinking = { type: "enabled", budgetTokens: Math.min(budget, Math.max(0, outputTokens - 1024)) };
      }
    }
    const headers = Object.entries(request.headers ?? {}).filter(([, value]) => value !== null)
      .map(([name, value]) => `${name}: ${value}`).join("\n");
    const sdkOptions: Options = {
      cwd, model: model.id, tools: [], mcpServers: tools.length ? { pi: server } : {},
      allowedTools: [...names.keys()], permissionMode: "dontAsk",
      systemPrompt, includePartialMessages: true,
      settingSources: [], skills: [], settings: { autoMemoryEnabled: false, claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**"] },
      env: { ...process.env, ...request.env,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "0",
        ENABLE_TOOL_SEARCH: "false", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(outputTokens),
        ...(headers ? { ANTHROPIC_CUSTOM_HEADERS: headers } : {}),
        ...(request.cacheRetention === "none" ? { DISABLE_PROMPT_CACHING: "1" } : {}),
      },
      extraArgs: { "strict-mcp-config": null },
      ...(mappedEffort && adaptive ? { effort: mappedEffort as Options["effort"] } : {}),
      thinking,
      ...(resume ? { resume, resumeSessionAt } : { persistSession: main }),
    };
    try {
      q.query = runQuery({ prompt: input.stream, options: sdkOptions });
      void input.push(userMessage(prompt.length ? prompt as any : "Continue from the conversation and tool results above."))
        .catch((error) => { if (!q.stopped) stop(q, error); });
      void consume(q, names);
    } catch (error) { stop(q, error instanceof Error ? error : new Error(String(error))); }
  }

  return {
    streamSimple(model: Model<any>, context: TranscriptContext, request: SimpleStreamOptions = {}) {
      const stream = createAssistantMessageEventStream();
      void start(model, context, request, stream).catch((error) => {
        const owner = [...running].find((q) => q.stream === stream);
        if (owner) { stop(owner, error instanceof Error ? error : new Error(String(error)), request.signal?.aborted); return; }
        const output = outputFor(model);
        output.stopReason = request.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      });
      return stream;
    },
    restore(state?: ClaudeSession) { saved = state; },
    reset() {
      generation++;
      saved = undefined;
      for (const q of [...running]) stop(q, new Error("Pi session context changed"), true);
    },
    dispose() {
      generation++;
      disposed = true;
      for (const q of [...running]) stop(q, new Error("Pi session shut down"), true);
    },
  };
}
