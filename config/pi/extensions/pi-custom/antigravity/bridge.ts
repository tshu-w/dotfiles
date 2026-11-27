import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentTools, getSystemMessageText,
  type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { AGENT_DEFINITION, createAcpConnection } from "./transport.js";
import { HISTORY_IMPORT_POLICY, MAX_PROMPT_TEXT_BYTES, PROMPT_TOO_LONG, boundedToolResultText, prepareHistory, splitPromptText, writeHistory, type ImportLosses } from "./history.js";
import { createNativeUsageReader, type NativeUsageSnapshot } from "./usage.js";
import { rewriteToolReferences } from "../tool-references.js";
import { withoutPiDefaults } from "../system-prompt.js";

// Pi aliases the package root to a file; use its models entry to locate the exported estimator.
const { estimateMessageTokens } = createRequire(import.meta.resolve("@earendil-works/pi-ai/models"))("./utils/estimate.js");

export const PROVIDER_ID = "antigravity";
const routing = (hasTools: boolean) => hasTools
  ? "Use only the Pi tools exposed through MCP. Short tool names in the following instructions refer to their mcp_pi_<name> counterparts."
  : "No Pi tools are available for this request.";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function supportsHistory(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const minimum = [1, 5, 15];
  for (let index = 0; index < minimum.length; index++) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return !match[4];
}

// Usage and timestamps do not change the conversation being continued.
function historyKey(messages: any[]): string {
  return digest(messages.map(({ role, content, toolCallId, toolName, isError }) => ({ role, content, toolCallId, toolName, isError })));
}

export function sessionRequest(cwd: string, mcpServer: any, systemPrompt: string, initialized: any, hasTools: boolean) {
  if (initialized?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append !== true) {
    throw new Error("Antigravity ACP requires systemPrompt.append support; upgrade agy (tested with 1.5.6)");
  }
  if (mcpServer && initialized.agentCapabilities.mcpCapabilities?.http !== true) {
    throw new Error("Antigravity ACP does not support HTTP MCP servers");
  }
  return {
    cwd, mcpServers: mcpServer ? [mcpServer] : [],
    _meta: { antigravity: {
      systemPrompt: { append: [routing(hasTools), systemPrompt].filter(Boolean).join("\n\n") },
      eagerMcpServers: mcpServer ? ["pi"] : [], enabledTools: [],
    } },
  };
}

function outputFor(model: Model<any>): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: "pending", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

export function promptContent(messages: any[]): any[] {
  return messages.flatMap((message, index) => {
    if (message.role !== "user") throw new Error("ACP continuation requires user input");
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.map((block: any) => {
      if (block.type === "text" || block.type === "image") return block;
      throw new Error(`Unsupported Antigravity input: ${block.type}`);
    });
    return index > 0 ? [{ type: "text", text: "\n\n" }, ...blocks] : blocks;
  });
}

function checkedPromptBytes(prompt: any[]): number {
  const bytes = prompt.reduce((sum, block) => sum + Buffer.byteLength(
    block.type === "text" ? block.text : "", "utf8"), 0);
  if (bytes > MAX_PROMPT_TEXT_BYTES) {
    throw new Error(PROMPT_TOO_LONG);
  }
  return bytes;
}

function requireIntactContext(snapshot: NativeUsageSnapshot) {
  if (snapshot.contextIntegrity.status !== "intact") {
    throw new Error(snapshot.contextIntegrity.status === "truncated" ? PROMPT_TOO_LONG : "Antigravity native context unavailable");
  }
}

const DEFAULT_PROFILE = "antigravity-cli";
const validSessionId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

function geminiRoot(cwd: string, overrides?: Record<string, string>) {
  const env = { ...process.env, ...overrides };
  return resolve(cwd, env.GEMINI_HOME || join(env.HOME || homedir(), ".gemini"));
}

export interface BridgeState {
  sessionId: string;
  appDataDir?: string; // Legacy isolated-profile checkpoints are rejected.
  imported?: true;
  configuration: string;
  historyLength: number;
  historyKey: string;
}

type Connection = Awaited<ReturnType<typeof createAcpConnection>>;
type PendingTool = { id: string; name: string; args: any; declaresToolSummary: boolean; resolve(value: any): void; reject(error: Error): void; emitted: boolean };

export function createAntigravityBridge(options: {
  cwd(): string;
  piSessionId?(): string | undefined;
  independent?: boolean;
  onImport?(losses: ImportLosses): void;
  save?(state: BridgeState): boolean | void;
  claim?(state: BridgeState): boolean;
  connect?: typeof createAcpConnection;
  usageReader?: typeof createNativeUsageReader;
}) {
  let checkpoint: BridgeState | undefined;
  let checkpointShared = false;
  let interruptedTool: { id: string; error: Error } | undefined;
  let selection: string | undefined;
  let connection: Connection | undefined;
  let sessionId: string | undefined;
  let imported = false;
  let configuration: string | undefined;
  let history: any[] = [];
  let stream: AssistantMessageEventStream | undefined;
  let streamRevision = 0;
  let output: AssistantMessage | undefined;
  let request: SimpleStreamOptions = {};
  let model: Model<any>;
  let prompting = false;
  let toolDelivered = false;
  let promptUsage: { used?: number; ordinal: number } | undefined;
  let usageReader: ReturnType<typeof createNativeUsageReader> | undefined;
  let publishedGeneration: number | undefined;
  let publishedOrdinal = 0;
  let reportedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  let tools: PendingTool[] = [];
  let removeAbort: (() => void) | undefined;
  const ended = new WeakSet<AssistantMessageEventStream>();
  let openBlock: number | undefined;

  function closeBlock() {
    if (openBlock === undefined || !stream || !output) return;
    const block = output.content[openBlock];
    if (block.type === "text" || block.type === "thinking") {
      stream.push({ type: `${block.type}_end`, contentIndex: openBlock,
        content: block.type === "text" ? block.text : block.thinking, partial: output } as any);
    }
    openBlock = undefined;
  }

  function terminal(reason: "stop" | "toolUse" | "length" | "error" | "aborted", error?: Error) {
    if (!stream || !output) return;
    closeBlock();
    const target = stream, message = output;
    ended.add(target);
    stream = undefined;
    output = undefined;
    if (reason !== "toolUse") {
      removeAbort?.();
      removeAbort = undefined;
    }
    message.stopReason = reason;
    if (reason === "error" || reason === "aborted") {
      message.errorMessage = error?.message ?? "Antigravity request aborted";
      target.push({ type: "error", reason, error: message });
    } else {
      history.push(structuredClone(message));
      if (reason !== "toolUse") {
        checkpoint = { sessionId: sessionId!, ...(imported ? { imported: true as const } : {}), configuration: configuration!, historyLength: history.length, historyKey: historyKey(history) };
        checkpointShared = false;
      }
      target.push({ type: "done", reason, message });
    }
    target.end();
  }

  function reset(error = new Error("Antigravity session context changed")) {
    if (toolDelivered && error.name !== "AbortError") error = new DOMException(error.message, "AbortError");
    const pending = !stream && error.name === "AbortError" ? tools.find((tool) => tool.emitted) : undefined;
    interruptedTool = pending ? { id: pending.id, error } : undefined;
    generation++;
    terminal(request.signal?.aborted || error.name === "AbortError" ? "aborted" : "error", error);
    removeAbort?.();
    removeAbort = undefined;
    for (const tool of tools) tool.reject(error);
    tools = [];
    void connection?.close().catch(() => {});
    connection = undefined;
    sessionId = undefined;
    imported = false;
    configuration = undefined;
    selection = undefined;
    checkpoint = undefined;
    checkpointShared = false;
    history = [];
    prompting = false;
    toolDelivered = false;
    promptUsage = undefined;
    usageReader = undefined;
    publishedGeneration = undefined;
    publishedOrdinal = 0;
    reportedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    queue = Promise.resolve();
  }

  function publishUsage(snapshot: NativeUsageSnapshot, raw: typeof reportedUsage, source: "native_generation" | "acp_used", acp?: Record<string, unknown>) {
    const delta = { ...raw };
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      delta[field] -= reportedUsage[field];
      if (!Number.isSafeInteger(delta[field]) || delta[field] < 0) throw new Error("Antigravity native usage unavailable");
    }
    if (source === "acp_used" && (promptUsage!.ordinal <= publishedOrdinal
      || (publishedGeneration !== undefined && snapshot.generationIndex <= publishedGeneration))) {
      throw new Error("Antigravity native usage unavailable");
    }
    Object.assign(output!.usage, {
      ...(options.independent ? {
        ...delta, totalTokens: delta.input + delta.output + delta.cacheRead + delta.cacheWrite,
      } : {
        input: snapshot.totalTokens - snapshot.cacheRead, output: snapshot.output,
        cacheRead: snapshot.cacheRead, cacheWrite: snapshot.cacheWrite, totalTokens: snapshot.totalTokens,
      }),
      antigravity: { raw: delta, last: {
        input: snapshot.input, output: snapshot.output, cacheRead: snapshot.cacheRead, cacheWrite: snapshot.cacheWrite,
      }, source, ...(acp ? { acp } : {}) },
    });
    reportedUsage = raw;
    publishedGeneration = snapshot.generationIndex;
    publishedOrdinal = promptUsage?.ordinal ?? 0;
  }

  function emitTool() {
    const tool = tools.find((entry) => !entry.emitted);
    if (!tool || !stream || !output) return;
    const snapshot = usageReader!.readTool(tool.name, tool.args, tool.declaresToolSummary);
    const raw = snapshot.generations.reduce((sum, row) => ({
      input: sum.input + row.input, output: sum.output + row.output,
      cacheRead: sum.cacheRead + row.cacheRead, cacheWrite: sum.cacheWrite + row.cacheWrite,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    publishUsage(snapshot, raw, "native_generation");
    requireIntactContext(snapshot);
    tool.emitted = true;
    toolDelivered = true;
    closeBlock();
    const index = output.content.length;
    output.content.push({ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args });
    stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
    stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(tool.args), partial: output });
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall: output.content[index] as any, partial: output });
    terminal("toolUse");
  }

  function update(params: any, epoch: number) {
    const activePrompt = promptUsage;
    queue = queue.then(async () => {
      if (epoch !== generation || params.sessionId !== sessionId) return;
      const owner = stream;
      await request.onProviderStreamEvent?.(params, model);
      if (epoch !== generation || params.sessionId !== sessionId) return;
      const event = params.update;
      if (event?.sessionUpdate === "usage_update") {
        if (prompting && activePrompt && activePrompt === promptUsage && Number.isSafeInteger(event.used) && event.used > 0) {
          activePrompt.used = event.used;
          activePrompt.ordinal++;
        }
        return;
      }
      if (stream !== owner || !stream || !output) return;
      const type = event?.sessionUpdate === "agent_message_chunk" ? "text"
        : event?.sessionUpdate === "agent_thought_chunk" ? "thinking" : undefined;
      if (!type || event.content?.type !== "text") return;
      if (openBlock !== undefined && output.content[openBlock].type !== type) closeBlock();
      if (openBlock === undefined) {
        openBlock = output.content.length;
        output.content.push(type === "text" ? { type, text: "" } : { type, thinking: "" });
        stream.push({ type: `${type}_start`, contentIndex: openBlock, partial: output } as any);
      }
      const block = output.content[openBlock];
      const value = event.content.text;
      if (block.type === "text") block.text += value;
      else if (block.type === "thinking") block.thinking += value;
      stream.push({ type: `${type}_delta`, contentIndex: openBlock, delta: value, partial: output } as any);
    });
    void queue.catch((error) => {
      if (epoch === generation) reset(prompting ? new DOMException(error.message, "AbortError") : error);
    });
  }

  async function start(target: AssistantMessageEventStream, selected: Model<any>, context: TranscriptContext, settings: SimpleStreamOptions) {
    const startedGeneration = generation;
    const startedPrompt = promptUsage, startedStreamRevision = streamRevision;
    const followsTool = prompting && toolDelivered;
    settings.signal?.throwIfAborted();
    if (settings.fetch) throw new Error("Antigravity ACP cannot use custom fetch");
    if (settings.maxTokens === 1) throw new Error("Antigravity ACP does not support cache-warming replays");
    const system = getCurrentSystemMessage(context.messages);
    const originalPrompt = system ? getSystemMessageText(system) : "";
    const initial = {
      systemPrompt: originalPrompt,
      tools: settings.toolChoice === "none" ? [] : getCurrentTools(context.messages),
      messages: context.messages.filter((message) => message.role !== "system"),
    };
    const payload = await settings.onPayload?.(initial, selected) ?? initial;
    if (followsTool && (startedPrompt !== promptUsage || startedStreamRevision !== streamRevision)) {
      if (interruptedTool && context.messages.some(message => message.role === "toolResult" && message.toolCallId === interruptedTool!.id)) {
        throw interruptedTool.error;
      }
      throw new DOMException("Antigravity tool continuation is no longer current", "AbortError");
    }
    const effective = payload as { systemPrompt: string; tools: any[]; messages: any[] };
    let systemPrompt = effective.systemPrompt;
    if (systemPrompt === originalPrompt && system?.sections) {
      const sections = withoutPiDefaults(system.sections);
      const names = new Map<string, string>(effective.tools.map((tool) => [`mcp_pi_${tool.name}`, tool.name]));
      for (const name of ["tools", "rules", "skills"]) {
        if (sections[name]) sections[name] = rewriteToolReferences(sections[name], names);
      }
      systemPrompt = getSystemMessageText({ ...system, sections });
    }
    const messages = effective.messages.filter((message) => message.role !== "assistant" || !["error", "aborted"].includes(message.stopReason));
    const interrupted = interruptedTool;
    interruptedTool = undefined;
    if (interrupted && messages.some((message) => message.role === "toolResult" && message.toolCallId === interrupted.id)) throw interrupted.error;
    if (startedGeneration !== generation) throw new Error("Pi session context changed before the request started");
    let boundary = messages.length;
    while (boundary > 0 && messages[boundary - 1].role === "user") boundary--;
    const currentPrompt = promptContent(messages.slice(boundary));
    const projected = [...messages.slice(0, boundary), ...(currentPrompt.length ? [{ role: "user", content: currentPrompt, timestamp: 0 }] : [])].flatMap(message => {
      if (message.role === "user") {
        const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
        if (content.every((block: any) => block.type === "text")) {
          return splitPromptText(content.map((block: any) => block.text).join("")).map(text => ({ ...message, content: text }));
        }
      }
      if (message.role === "toolResult") {
        const text = boundedToolResultText(message.content.map((block: any) => block.type === "text" ? block.text : "[Pi omitted an image]").join("\n"), message.isError);
        return [{ ...message, content: [{ type: "text", text: (message.isError ? "Encountered error in tool execution: " : "") + text }] }];
      }
      if (message.role === "assistant") return [{ ...message, content: message.content.filter((block: any) => block.type !== "thinking")
        .map((block: any) => block.type === "toolCall" ? { ...block, name: `mcp_pi_${block.name}` } : block) }];
      return [message];
    });
    const estimated = estimateMessageTokens({ role: "system", timestamp: 0,
      content: [routing(effective.tools.length > 0), systemPrompt].filter(Boolean).join("\n\n"),
      toolsAdded: effective.tools.map(tool => ({ name: `mcp_pi_${tool.name}`, description: tool.description, parameters: tool.parameters })),
    }) + projected.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (estimated > selected.contextWindow) throw new Error(PROMPT_TOO_LONG);
    const requestedRoot = geminiRoot(options.cwd(), settings.env);
    let root: string | undefined;
    try { root = realpathSync(requestedRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const configParts = [AGENT_DEFINITION, HISTORY_IMPORT_POLICY, routing(effective.tools.length > 0), options.cwd(), systemPrompt, effective.tools, settings.env];
    let config = digest([...configParts, root]);
    const selectedConfig = digest([selected.id, settings.reasoning]);
    if (stream) throw new Error("Antigravity ACP already has an active stream");
    if (connection && !prompting && (connection.closed || selection !== selectedConfig)) {
      const saved = checkpoint, shared = checkpointShared;
      reset();
      checkpoint = saved;
      checkpointShared = shared;
    }
    if (checkpointShared) {
      if (options.claim?.(checkpoint!) === false) reset();
      checkpointShared = false;
    }
    const prefix = historyKey(messages.slice(0, history.length)) === historyKey(history) && messages.length >= history.length;
    const suffix = prefix ? messages.slice(history.length) : messages;
    const pending = tools.find((entry) => entry.emitted);
    const continuation = pending && suffix.length === 1 && suffix[0].role === "toolResult" && suffix[0].toolCallId === pending.id;
    if (connection && (configuration !== config || !prefix || (prompting ? !continuation || selection !== selectedConfig : !suffix.length || !suffix.every((message) => message.role === "user")))) reset();
    const currentBytes = currentPrompt.reduce((sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0), 0);
    let chunks: string[] | undefined;
    if (currentBytes > MAX_PROMPT_TEXT_BYTES) {
      if (currentPrompt.some(block => block.type !== "text")) throw new Error(PROMPT_TOO_LONG);
      const text = currentPrompt.map(block => block.text).join("");
      if (!text.isWellFormed()) throw new Error("Antigravity cannot import this history. Compact with another model or start a new conversation.");
      chunks = splitPromptText(text);
      // Rebuild the complete source history into a fresh stopped target, never
      // append chunks to the database of a live or restored session.
      reset();
    }
    const epoch = generation;
    model = selected;
    request = settings;
    stream = target;
    streamRevision++;
    output = outputFor(selected);
    const abort = () => reset(new Error("Antigravity request aborted"));
    removeAbort?.();
    settings.signal?.addEventListener("abort", abort, { once: true });
    removeAbort = () => settings.signal?.removeEventListener("abort", abort);
    settings.signal?.throwIfAborted();
    const fresh = !connection;
    let restored = fresh && !chunks && checkpoint?.configuration === config
      && messages.length > checkpoint.historyLength
      && historyKey(messages.slice(0, checkpoint.historyLength)) === checkpoint.historyKey
      && messages.slice(checkpoint.historyLength).every((message) => message.role === "user") ? checkpoint : undefined;
    checkpoint = undefined;
    const owner = options.piSessionId?.();
    if (restored?.appDataDir !== undefined
      || (restored?.imported && (!root || !owner || !validSessionId(restored.sessionId)))) restored = undefined;
    const open = async (profile?: { geminiDir: string; historyTarget?: true }, availableTools = effective.tools) => {
      const created = await (options.connect ?? createAcpConnection)(options.cwd(), {
        update: (params) => update(params, epoch),
        tool: async (name, args) => {
          if (!availableTools.length) throw new Error("Antigravity history setup cannot execute tools");
          await queue;
          if (epoch !== generation) throw new Error("Antigravity session closed");
          return new Promise((resolve, reject) => {
            tools.push({ id: `agy-${randomUUID()}`, name, args,
              declaresToolSummary: Object.hasOwn(availableTools.find(tool => tool.name === name)?.parameters?.properties ?? {}, "toolSummary"),
              resolve, reject, emitted: false });
            try { emitTool(); }
            catch (error) { reset(new DOMException(error instanceof Error ? error.message : String(error), "AbortError")); }
          });
        },
      }, availableTools, settings.env, settings.signal, profile);
      if (epoch !== generation) { await created.close(); throw new DOMException("Antigravity session context changed", "AbortError"); }
      connection = created;
      return created;
    };
    let importedLength = 0;
    let importedSession: string | undefined;
    let importedLosses: ImportLosses | undefined;
    if (fresh && !restored && (chunks || messages.some(message => message.role !== "user"))) {
      if (!chunks) checkedPromptBytes(currentPrompt);
      const projection = [...messages.slice(0, boundary), ...(chunks?.slice(0, -1).map(content => ({ role: "user" as const, content, timestamp: 0 })) ?? [])];
      const prepared = projection.length > 0 && boundary < messages.length
        ? prepareHistory(projection) : undefined;
      if (boundary === messages.length && messages.at(-1)?.role === "toolResult") {
        throw new Error("Antigravity cannot resume from a tool result. Send a new message to continue.");
      }
      if (!prepared) throw new Error("Antigravity cannot import this history. Compact with another model or start a new conversation.");
      if (!owner) throw new Error("Antigravity history import requires a Pi session ID.");
      if (!root) throw new Error("Antigravity history storage is unavailable.");
      const path = join(root, DEFAULT_PROFILE), conversations = join(path, "conversations");
      let created: Connection | undefined;
      const incompatible = new Error("Antigravity history storage layout is unsupported.");
      for (const directory of [path, conversations]) {
        const stat = lstatSync(directory, { throwIfNoEntry: false });
        if (stat && (!stat.isDirectory() || realpathSync(directory) !== directory)) throw incompatible;
      }
      let existing: string[];
      try { existing = readdirSync(conversations).map(name => name.toLowerCase()); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; existing = []; }
      try {
        created = await open({ geminiDir: root, historyTarget: true }, []);
        if (!supportsHistory(created.initialized?.agentInfo?.version)) throw new Error("Antigravity history import requires CLI 1.5.15 or later.");
        const params = sessionRequest(options.cwd(), undefined, systemPrompt, created.initialized, false);
        const session = await created.request("session/new", params);
        if (epoch !== generation) throw new DOMException("Antigravity session context changed", "AbortError");
        if (!validSessionId(session?.sessionId)) throw new Error("Invalid Antigravity import session ID");
        if (existing.some(name => name.startsWith(session.sessionId.toLowerCase() + ".db"))) throw incompatible;
        await created.request("session/close", { sessionId: session.sessionId });
        await created.close();
        if (epoch !== generation) throw new DOMException("Antigravity session context changed", "AbortError");
        settings.signal?.throwIfAborted();
        connection = undefined;
        const database = join(path, "conversations", session.sessionId + ".db");
        let identity: { dev: number; ino: number };
        try {
          const stat = lstatSync(database);
          if (realpathSync(database) !== database || !stat.isFile()) throw incompatible;
          identity = { dev: stat.dev, ino: stat.ino };
        }
        catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw incompatible;
          throw error;
        }
        if (!writeHistory(database, session.sessionId, prepared.steps, join(path, "brain", session.sessionId, ".user_uploaded"), identity)) {
          throw incompatible;
        }
        importedSession = session.sessionId;
        importedLength = boundary;
        importedLosses = prepared.losses;
      } catch (error) {
        // Native owns the shared profile and summaries; retain failed new sessions.
        if (created) {
          try { await created.close(); } catch { /* An unconfirmed writer stop grants no write or cleanup authority. */ }
        }
        if (epoch !== generation || settings.signal?.aborted) throw new DOMException("Antigravity history import aborted", "AbortError");
        throw error;
      }
    }
    if (!connection) {
      imported = !!(restored?.imported || importedSession);
      const active = await open({ geminiDir: root ?? requestedRoot });
      if (!root) {
        root = realpathSync(requestedRoot);
        config = digest([...configParts, root]);
      }
      const resumeId = restored?.sessionId ?? importedSession;
      if (imported && !supportsHistory(active.initialized?.agentInfo?.version)) {
        await active.close();
        if (epoch !== generation) throw new DOMException("Antigravity session context changed", "AbortError");
        throw new Error("Antigravity history import requires CLI 1.5.15 or later.");
      }
      const params = sessionRequest(options.cwd(), active.mcpServer, systemPrompt, active.initialized, effective.tools.length > 0);
      const session = await active.request(resumeId ? "session/resume" : "session/new",
        resumeId ? { ...params, sessionId: resumeId } : params);
      if (epoch !== generation) return;
      if (typeof session?.sessionId !== "string" || !session.sessionId || (resumeId && session.sessionId !== resumeId)) throw new Error("Antigravity returned an invalid session ID");
      sessionId = session.sessionId;
      const selector = session.configOptions?.find((option: any) => option.category === "model" || option.id === "model");
      const selectedModel = selector
        ? await active.request("session/set_config_option", { sessionId, configId: selector.id, value: selected.id })
        : await active.request("session/set_model", { sessionId, modelId: selected.id });
      if (settings.reasoning) {
        const selector = (selectedModel.configOptions ?? session.configOptions)?.find((option: any) => option.category === "thought_level" || option.id === "thinking_level");
        if (!selector) throw new Error("Antigravity does not advertise a thinking-level selector for this model");
        await active.request("session/set_config_option", { sessionId, configId: selector.id, value: settings.reasoning });
      }
      configuration = config;
      selection = selectedConfig;
      usageReader = (options.usageReader ?? createNativeUsageReader)(join(root, DEFAULT_PROFILE), sessionId!);
    }
    if (epoch !== generation) return;
    target.push({ type: "start", partial: output! });
    if (prompting) {
      const tool = tools.find((entry) => entry.emitted)!;
      const result = messages.at(-1);
      history = structuredClone(messages);
      tools = tools.filter((entry) => entry !== tool);
      // Attach the next Pi stream before releasing the parked MCP response.
      connection!.setPromptWatchdog(sessionId!, { timeoutMs: settings.timeoutMs });
      tool.resolve({ content: result.content, isError: result.isError });
      emitTool();
      return;
    }
    const unseen = restored ? messages.slice(restored.historyLength) : importedLength ? messages.slice(importedLength) : fresh ? messages : suffix;
    history = structuredClone(messages);
    prompting = true;
    toolDelivered = false;
    promptUsage = { ordinal: 0 };
    publishedGeneration = undefined;
    publishedOrdinal = 0;
    reportedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let response: any;
    try {
      const prompt = chunks ? [{ type: "text", text: chunks.at(-1)! }] : promptContent(unseen);
      checkedPromptBytes(prompt);
      const capabilities = connection!.initialized.agentCapabilities.promptCapabilities;
      if (prompt.some((block) => block.type === "image") && capabilities?.image !== true) {
        throw new Error("Antigravity ACP does not support image prompts");
      }
      if ((!settings.sessionId || settings.sessionId === owner)
        && importedLosses && Object.values(importedLosses).some(count => count > 0)) options.onImport?.(importedLosses);
      usageReader!.beginPrompt();
      response = await connection!.request("session/prompt", { sessionId, prompt }, { timeoutMs: settings.timeoutMs });
      await queue;
    } catch (error) {
      if (epoch === generation) reset(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (epoch !== generation) return;
    if (response.stopReason === "cancelled" || tools.length || !output) {
      reset(new Error(response.stopReason === "cancelled"
        ? "Antigravity cancelled the request" : "Antigravity finished while a Pi tool was pending"));
      return;
    }
    if (response.stopReason === "max_tokens" && toolDelivered) {
      reset(new Error("Antigravity stopped after tool delivery: max_tokens"));
      return;
    }
    try {
      if (promptUsage?.used === undefined) throw new Error("Antigravity native usage unavailable");
      const snapshot = usageReader!.readCompletion(promptUsage.used);
      const usage = response.usage;
      const raw = snapshot.generations.reduce((sum, row) => ({
        input: sum.input + row.input, output: sum.output + row.output,
        cacheRead: sum.cacheRead + row.cacheRead, cacheWrite: sum.cacheWrite + row.cacheWrite,
      }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      const acp = usage ? Object.fromEntries(
        ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"].map(key =>
          [key, Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : null]),
      ) : undefined;
      publishUsage(snapshot, raw, "acp_used", acp);
      requireIntactContext(snapshot);
    } catch (error) {
      reset(new DOMException(error instanceof Error ? error.message : String(error), "AbortError"));
      return;
    }
    prompting = false;
    promptUsage = undefined;
    if (["refusal", "max_turn_requests"].includes(response.stopReason)) reset(new Error(`Antigravity stopped: ${response.stopReason}`));
    else if (!output.content.some((block) => block.type === "text" && block.text.trim())) {
      reset(new Error("Antigravity finished without a text response; check tool permissions and ACP events"));
    } else {
      terminal(response.stopReason === "max_tokens" ? "length" : "stop");
    }
  }

  return {
    reset,
    restore(state: BridgeState | undefined) { checkpoint = state; checkpointShared = !!state; },
    settle() {
      interruptedTool = undefined;
      if (prompting && !stream) reset(new Error("Pi stopped while an Antigravity tool was pending"));
      else if (!prompting && checkpoint && !checkpointShared) checkpointShared = options.save?.(checkpoint) === true;
    },
    streamSimple(selected: Model<any>, context: TranscriptContext, settings: SimpleStreamOptions = {}) {
      const target = createAssistantMessageEventStream();
      const originalPrompt = promptUsage, originalStreamRevision = streamRevision;
      const followsTool = prompting && toolDelivered;
      void start(target, selected, context, settings).catch((error) => {
        if (ended.has(target)) return;
        const unsafe = followsTool || (stream === target && prompting && toolDelivered);
        if (unsafe) error = new DOMException(error instanceof Error ? error.message : String(error), "AbortError");
        if (stream === target) reset(error instanceof Error ? error : new Error(String(error)));
        else {
          if (unsafe && originalPrompt === promptUsage && originalStreamRevision === streamRevision) reset(error);
          const message = outputFor(selected);
          message.stopReason = settings.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "aborted" : "error";
          message.errorMessage = error instanceof Error ? error.message : String(error);
          ended.add(target);
          target.push({ type: "error", reason: message.stopReason, error: message });
          target.end();
        }
      });
      return target;
    },
  };
}
