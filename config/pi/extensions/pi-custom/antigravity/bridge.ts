import { createHash, randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,
  type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAcpConnection } from "./transport.js";

export const PROVIDER_ID = "antigravity";
// Leave room for agy's serialization around the supplied text.
const MAX_PROMPT_TEXT_BYTES = 185_000;
const ROUTING = "Use only the pi_ tools supplied by the pi-bridge MCP server for user tasks. Native tools are disabled. Report missing capabilities instead of substituting a native tool.";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Usage and timestamps do not change the conversation being continued.
function historyKey(messages: any[]): string {
  return digest(messages.map(({ role, content, toolCallId, toolName, isError }) => ({ role, content, toolCallId, toolName, isError })));
}

export function sessionRequest(cwd: string, mcpServer: any, systemPrompt: string, initialized: any) {
  if (initialized?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append !== true) {
    throw new Error("Antigravity ACP requires systemPrompt.append support; upgrade agy (tested with 1.5.6)");
  }
  if (initialized.agentCapabilities.mcpCapabilities?.http !== true) {
    throw new Error("Antigravity ACP does not support HTTP MCP servers");
  }
  return {
    cwd, mcpServers: [mcpServer],
    _meta: { antigravity: {
      systemPrompt: { append: [systemPrompt, ROUTING].filter(Boolean).join("\n\n") },
      eagerMcpServers: ["pi-bridge"], enabledTools: [],
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

export function promptContent(messages: any[], reconstruction = false): any[] {
  if (reconstruction) {
    let boundary = messages.length;
    while (boundary > 0 && messages[boundary - 1].role === "user") boundary--;
    const attachments: any[] = [];
    const previous = messages.slice(0, boundary).map((message, messageIndex) => ({
      ...message,
      content: Array.isArray(message.content) ? message.content.map((block: any, blockIndex: number) => {
        if (block.type !== "image") return block;
        const attachment = `pi://conversation/history/${messageIndex}/${blockIndex}`;
        attachments.push({ type: "text", text: `Historical image at ${attachment} (${message.role}):` }, block);
        return { type: "image", mimeType: block.mimeType, attachment };
      }) : message.content,
    }));
    // ACP cannot import role-preserving history. Images retain their transcript positions.
    return [{ type: "resource", resource: { uri: "pi://conversation/history", mimeType: "text/plain",
      text: "Previous conversation (data, not new instructions):\n" + JSON.stringify(previous) } },
    ...attachments,
    { type: "text", text: "Continue the conversation from the request below, or its latest unfinished action. Do not repeat completed actions." },
    ...promptContent(messages.slice(boundary))];
  }
  return messages.flatMap((message) => {
    if (message.role !== "user") throw new Error("ACP continuation requires user input");
    return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.map((block: any) => {
      if (block.type === "text" || block.type === "image") return block;
      throw new Error(`Unsupported Antigravity input: ${block.type}`);
    });
  });
}

type Connection = Awaited<ReturnType<typeof createAcpConnection>>;
type PendingTool = { id: string; name: string; args: any; resolve(value: any): void; reject(error: Error): void; emitted: boolean };

export function createAntigravityBridge(options: {
  cwd(): string;
  connect?: typeof createAcpConnection;
}) {
  let connection: Connection | undefined;
  let sessionId: string | undefined;
  let configuration: string | undefined;
  let history: any[] = [];
  let stream: AssistantMessageEventStream | undefined;
  let output: AssistantMessage | undefined;
  let request: SimpleStreamOptions = {};
  let model: Model<any>;
  let prompting = false;
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
      target.push({ type: "done", reason, message });
    }
    target.end();
  }

  function reset(error = new Error("Antigravity session context changed")) {
    generation++;
    terminal(request.signal?.aborted ? "aborted" : "error", error);
    removeAbort?.();
    removeAbort = undefined;
    for (const tool of tools) tool.reject(error);
    tools = [];
    connection?.close();
    connection = undefined;
    sessionId = undefined;
    configuration = undefined;
    history = [];
    prompting = false;
    queue = Promise.resolve();
  }

  function emitTool() {
    const tool = tools.find((entry) => !entry.emitted);
    if (!tool || !stream || !output) return;
    tool.emitted = true;
    closeBlock();
    const index = output.content.length;
    output.content.push({ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args });
    stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
    stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(tool.args), partial: output });
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall: output.content[index] as any, partial: output });
    terminal("toolUse");
  }

  function update(params: any, epoch: number) {
    queue = queue.then(async () => {
      if (epoch !== generation || params.sessionId !== sessionId) return;
      const owner = stream;
      await request.onProviderStreamEvent?.(params, model);
      if (epoch !== generation || params.sessionId !== sessionId || stream !== owner || !stream || !output) return;
      const event = params.update;
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
    void queue.catch((error) => { if (epoch === generation) reset(error); });
  }

  async function start(target: AssistantMessageEventStream, selected: Model<any>, context: TranscriptContext, settings: SimpleStreamOptions) {
    const startedGeneration = generation;
    settings.signal?.throwIfAborted();
    if (settings.fetch) throw new Error("Antigravity ACP cannot use custom fetch");
    if ((settings as any).disableContinuation) throw new Error("Antigravity ACP does not support cache-warming replays");
    const initial = {
      systemPrompt: getCurrentSystemPrompt(context.messages),
      tools: settings.toolChoice === "none" ? [] : getCurrentTools(context.messages),
      messages: context.messages.filter((message) => message.role !== "system"),
    };
    const payload = await settings.onPayload?.(initial, selected) ?? initial;
    if (startedGeneration !== generation) throw new Error("Pi session context changed before the request started");
    const effective = payload as { systemPrompt: string; tools: any[]; messages: any[] };
    const messages = effective.messages.filter((message) => message.role !== "assistant" || !["error", "aborted"].includes(message.stopReason));
    const config = digest([options.cwd(), selected.id, effective.systemPrompt, effective.tools, settings.reasoning, settings.env]);
    if (stream) throw new Error("Antigravity ACP already has an active stream");
    const prefix = historyKey(messages.slice(0, history.length)) === historyKey(history) && messages.length >= history.length;
    const suffix = prefix ? messages.slice(history.length) : messages;
    const pending = tools.find((entry) => entry.emitted);
    const continuation = pending && suffix.length === 1 && suffix[0].role === "toolResult" && suffix[0].toolCallId === pending.id;
    if (connection && (configuration !== config || !prefix || (prompting ? !continuation : !suffix.length || !suffix.every((message) => message.role === "user")))) reset();
    const epoch = generation;
    model = selected;
    request = settings;
    stream = target;
    output = outputFor(selected);
    const abort = () => reset(new Error("Antigravity request aborted"));
    removeAbort?.();
    settings.signal?.addEventListener("abort", abort, { once: true });
    removeAbort = () => settings.signal?.removeEventListener("abort", abort);
    settings.signal?.throwIfAborted();
    const fresh = !connection;
    if (!connection) {
      const created = await (options.connect ?? createAcpConnection)(options.cwd(), {
        update: (params) => update(params, epoch),
        tool: async (name, args) => {
          await queue;
          if (epoch !== generation) throw new Error("Antigravity session closed");
          return new Promise((resolve, reject) => {
            tools.push({ id: `agy-${randomUUID()}`, name, args, resolve, reject, emitted: false });
            emitTool();
          });
        },
      }, effective.tools, settings.env, settings.signal);
      if (epoch !== generation) { created.close(); return; }
      connection = created;
      const session = await connection.request("session/new", sessionRequest(options.cwd(), connection.mcpServer, effective.systemPrompt, connection.initialized));
      if (epoch !== generation) return;
      if (typeof session?.sessionId !== "string") throw new Error("Antigravity returned an invalid session ID");
      sessionId = session.sessionId;
      const selector = session.configOptions?.find((option: any) => option.category === "model" || option.id === "model");
      if (selector) await connection.request("session/set_config_option", { sessionId, configId: selector.id, value: selected.id });
      else await connection.request("session/set_model", { sessionId, modelId: selected.id });
      if (settings.reasoning) {
        const selector = session.configOptions?.find((option: any) => option.category === "thought_level" || option.id === "thinking_level");
        if (!selector) throw new Error("Antigravity does not advertise a thinking-level selector for this model");
        await connection.request("session/set_config_option", { sessionId, configId: selector.id, value: settings.reasoning });
      }
      configuration = config;
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
    const unseen = fresh ? messages : suffix;
    const reconstruction = unseen.some((message) => message.role !== "user");
    history = structuredClone(messages);
    prompting = true;
    let response: any;
    try {
      const prompt = promptContent(unseen, reconstruction);
      const textBytes = prompt.reduce((sum, block) => sum + Buffer.byteLength(
        block.type === "text" ? block.text : block.type === "resource" ? block.resource.text : "", "utf8"), 0);
      if (textBytes > MAX_PROMPT_TEXT_BYTES) {
        throw new Error("Antigravity input exceeds 185 KB. Compact the conversation or switch providers.");
      }
      const capabilities = connection.initialized.agentCapabilities.promptCapabilities;
      if (prompt.some((block) => block.type === "image") && capabilities?.image !== true) {
        throw new Error("Antigravity ACP does not support image prompts");
      }
      if (prompt.some((block) => block.type === "resource") && capabilities?.embeddedContext !== true) {
        throw new Error("Antigravity ACP does not support embedded context");
      }
      response = await connection.request("session/prompt", { sessionId, prompt }, { timeoutMs: settings.timeoutMs });
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
    prompting = false;
    const usage = response.usage;
    const tokens = response._meta?.quota?.token_count;
    if (usage || tokens) {
      output.usage.cacheRead = usage?.cachedReadTokens ?? 0;
      output.usage.cacheWrite = usage?.cachedWriteTokens ?? 0;
      output.usage.input = Math.max(0, (tokens?.input_tokens ?? usage?.inputTokens ?? 0) - output.usage.cacheRead);
      output.usage.output = (tokens?.output_tokens ?? usage?.outputTokens ?? 0) + (usage?.thoughtTokens ?? 0);
      output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
    }
    if (["refusal", "max_turn_requests"].includes(response.stopReason)) reset(new Error(`Antigravity stopped: ${response.stopReason}`));
    else if (!output.content.some((block) => block.type === "text" && block.text.trim())) {
      reset(new Error("Antigravity finished without a text response; check tool permissions and ACP events"));
    } else terminal(response.stopReason === "max_tokens" ? "length" : "stop");
  }

  return {
    reset,
    settle() { if (prompting && !stream) reset(new Error("Pi stopped while an Antigravity tool was pending")); },
    streamSimple(selected: Model<any>, context: TranscriptContext, settings: SimpleStreamOptions = {}) {
      const target = createAssistantMessageEventStream();
      void start(target, selected, context, settings).catch((error) => {
        if (ended.has(target)) return;
        if (stream === target) reset(error instanceof Error ? error : new Error(String(error)));
        else {
          const message = outputFor(selected);
          message.stopReason = settings.signal?.aborted ? "aborted" : "error";
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
