import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { query, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { createSession, getSessionPath } from "cc-session-io";
import {
  calculateCost, createAssistantMessageEventStream, getInitialSystemMessage, getSystemMessageText, getCurrentTools, resolveTranscript,
  type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { convertPiMessages } from "./convert.js";
import { createToolServer } from "./mcp-server.js";
import { makePromptStream, userMessage, type PromptStream } from "./prompt-stream.js";
import { toolResultToMcpContent, type McpResult } from "./extract-tool-results.js";
import { buildClaudeSystemPrompt } from "./system-prompt.js";
import { normalizeClaudeError, queryError, subscriptionEnvironment, typedClaudeError, USAGE_CREDITS_ERROR } from "./subscription.js";

export interface ClaudeSession {
  piSessionId: string;
  sessionId: string;
  cwd: string;
  // The Pi history the point continues: its length and the digest chained over its message hashes.
  size: number;
  tip: string;
  lastUuid?: string;
  // The tool calls the prefix ends with were answered in the CC session (an interrupted tool use).
  answered?: boolean;
  // Digests of the tool results handed to Claude Code as each tool finished, by tool call id.
  delivered?: Record<string, string>;
  // A tool-gap point waits on these tool calls; Claude Code marks them interrupted once its query ends.
  pending?: string[];
}

// What the state file holds: the main resume point, if any, and the recent points to fork from.
export interface BridgeState extends Partial<ClaudeSession> {
  piSessionId: string;
  points?: ClaudeSession[];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Exclude timestamps, usage and provider-specific response metadata from continuity checks.
function hashes(messages: any[]): string[] {
  return messages.map((m) => digest({
    role: m.role,
    sections: m.sections,
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

// System patches reach Claude Code as user text, so they may follow the resumed prefix.
function isInput(message: { role: string }): boolean {
  return message.role === "user" || message.role === "system";
}

// Digests chained over message hashes: entry i names the history up to message i.
function chain(messageHashes: string[]): string[] {
  const out: string[] = [];
  for (const hash of messageHashes) out.push(digest([out.at(-1) ?? "", hash]));
  return out;
}

function anchor(messageHashes: string[]): { size: number; tip: string } {
  return { size: messageHashes.length, tip: chain(messageHashes).at(-1) ?? "" };
}

function extendsPoint(point: ClaudeSession, tips: string[]): boolean {
  return point.size <= tips.length && (point.size === 0 || tips[point.size - 1] === point.tip);
}

function startsWith(history: string[], prefix: string[]): boolean {
  return history.length >= prefix.length && prefix.every((item, index) => history[index] === item);
}

// Whether `messages` continue the CC session at `point`: results for the tool calls it ends with, then input.
function continues(point: ClaudeSession, messages: any[], tips: string[]): boolean {
  if (!extendsPoint(point, tips)) return false;
  const last = messages[point.size - 1];
  const calls: string[] = last?.role === "assistant" ? last.content.filter((b: any) => b.type === "toolCall").map((b: any) => b.id) : [];
  const suffix = messages.slice(point.size);
  if (point.answered) {
    // Claude Code already answered every call; Pi may lack some results, as after a crash.
    const start = suffix.findIndex((m) => m.role !== "toolResult");
    const results = start < 0 ? suffix : suffix.slice(0, start);
    return results.every((m) => calls.includes(m.toolCallId) && matchesDelivered(point.delivered, m))
      && suffix.slice(results.length).every(isInput);
  }
  const results = suffix.slice(0, calls.length);
  return results.every((m) => m.role === "toolResult") && calls.every((id) => results.some((m) => m.toolCallId === id))
    && suffix.slice(calls.length).every(isInput);
}

// Messages after the point that Claude Code has not seen.
function unseen(point: ClaudeSession, messages: any[]): any[] {
  const suffix = messages.slice(point.size);
  if (!point.answered) return suffix;
  const start = suffix.findIndex((m) => m.role !== "toolResult");
  return start < 0 ? [] : suffix.slice(start);
}

// What Pi stored for a tool call; a result handed to Claude Code early must match it.
function resultDigest(content: unknown, isError: boolean | undefined): string {
  return digest({ content, isError: !!isError });
}

function matchesDelivered(delivered: Record<string, string> | undefined, message: any): boolean {
  const early = delivered?.[message.toolCallId];
  return early === undefined || early === resultDigest(message.content, message.isError);
}

// The last record of Claude Code's own results for `ids`, written when a query stopped at their tool gap.
// Only a record that completes the batch is a resume point.
function interruption(sessionId: string, cwd: string, configDir: string | undefined, ids: string[]): string | undefined {
  let records: any[];
  try {
    records = readFileSync(getSessionPath(sessionId, cwd, configDir), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  } catch {
    return undefined;
  }
  const answered = new Set<string>();
  let uuid: string | undefined;
  for (const r of records) {
    if (r.type !== "user" || !Array.isArray(r.message?.content)) continue;
    const found = r.message.content.filter((b: any) => b.type === "tool_result" && ids.includes(b.tool_use_id));
    if (!found.length) continue;
    for (const b of found) answered.add(b.tool_use_id);
    uuid = r.uuid;
  }
  return answered.size === ids.length ? uuid : undefined;
}

// A cut there would separate tool uses from their results, which the import then drops.
function endsWithToolCalls(message: any): boolean {
  return message?.role === "assistant" && message.content.some((b: any) => b.type === "toolCall");
}

// Claude Code's own request records, which a copied prefix leaves out.
const REQUEST_RECORDS = new Set(["api-request", "api-request-shape", "api-request-blob"]);

// A new session holding Claude Code's records up to the point verbatim, then `tail` imported from Pi,
// so a changed tail keeps the cached prefix. The cut also keeps records that follow the point's
// record on its chain before the next message, such as the prompt snapshot.
function writePrefixSession(point: ClaudeSession, tail: any[], model: string, configDir: string | undefined): string | undefined {
  let records: any[];
  try {
    records = readFileSync(getSessionPath(point.sessionId, point.cwd, configDir), "utf8").split("\n")
      .filter((line) => line.trim()).map((line) => JSON.parse(line)).filter((r) => !REQUEST_RECORDS.has(r.type));
  } catch {
    return undefined;
  }
  let end = records.findIndex((r) => r.uuid === point.lastUuid);
  if (end < 0) return undefined;
  let cut = point.lastUuid!;
  for (let i = end + 1; i < records.length && records[i].type !== "user" && records[i].type !== "assistant"; i++) {
    if (records[i].parentUuid === cut && typeof records[i].uuid === "string") { cut = records[i].uuid; end = i; }
  }
  const session = createSession({ projectPath: point.cwd, model, claudeDir: configDir });
  session.importMessages(convertPiMessages(tail).anthropicMessages);
  const kept = records.slice(0, end + 1).map((r) => r.sessionId ? { ...r, sessionId: session.sessionId } : r);
  const imported = session.records.map((r, index) => index === 0 ? { ...r, parentUuid: cut } : r);
  writeFileSync(session.jsonlPath, [...kept, ...imported].map((r) => JSON.stringify(r) + "\n").join(""), { flag: "wx" });
  return session.sessionId;
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
  blocks: Map<number, { index: number; json: string } | null>;
  sessionId?: string;
  lastUuid?: string;
  main: boolean;
  // A replay such as cache warming, which is never continued.
  replay: boolean;
  initialized?: boolean;
  // An error result before system/init: the CLI failed while loading the session.
  failedToLoad?: boolean;
  // The point a prefix session was cut at; a rejected load stops later requests from cutting there.
  cut?: ClaudeSession;
  limitRejected?: boolean;
  requester?: string;
  // Set for a fork of the main CC session; its session file is removed when the query ends.
  fork?: { configDir?: string; sessionId?: string };
  cwd: string;
  stopped: boolean;
  sawMessage: boolean;
  responded?: boolean;
  // The current API message has a tool use Claude Code answers itself, after its message_stop.
  skipped?: boolean;
  // Earlier API calls of this Pi turn (Claude Code may call the API several times per turn).
  prior?: { output: number; cost: AssistantMessage["usage"]["cost"] };
  callOutput: number;
  // A checkpoint waits until Claude Code has recorded these tool uses or results.
  expect?: { ids: Set<string>; prefix: string[]; gap: boolean };
  // Claude Code marks tool uses as interrupted when their query ends, which drops the turn on resume.
  gap?: { point: ClaudeSession; previous?: ClaudeSession; ids: string[] };
  // A withdrawn tool-gap point, re-anchored at CC's interrupted tool result once the CLI exits.
  interrupted?: { point: ClaudeSession; previous?: ClaudeSession; ids: string[] };
  configDir?: string;
  generation: number;
  // The point this query resumed or forked from.
  point?: ClaudeSession;
  recorded: { uses: Set<string>; results: Set<string> };
  delivered: Map<string, string>;
  removeAbort?: () => void;
}

const MAX_POINTS = 32;

function samePoint(a: ClaudeSession, b: ClaudeSession): boolean {
  return a.sessionId === b.sessionId && a.lastUuid === b.lastUuid && a.size === b.size && a.tip === b.tip;
}

// State files written before points were compact carry the full list of message hashes.
function migrate(point: ClaudeSession & { prefix?: string[] }): ClaudeSession {
  if (!Array.isArray(point.prefix)) return point;
  const { prefix, ...rest } = point;
  return { ...rest, ...anchor(prefix) };
}

// Points a resume failed from, shared because bridges fork from each other's points.
const failedPoints = new WeakSet<ClaudeSession>();
// How Claude Code's print mode reports a session or message it cannot resume.
const RESUME_FAILURE = /No conversation found|No message found with message\.uuid|Resume rejected by --resume-drops-turn|Failed to resume session|--resume requires a valid session/;

export function createClaudeBridge(options: {
  cwd: () => string;
  sessionId: () => string;
  save: (state: ClaudeSession) => void;
  clear: () => void;
  // Checkpoints of other Sessions' bridges that this bridge may fork from.
  forkSources: () => ClaudeSession[];
  query?: typeof query;
  trace?: (message: string) => void;
}) {
  const runQuery = options.query ?? query;
  const running = new Set<RunningQuery>();
  let saved: ClaudeSession | undefined;
  // Recent resume points of the main CC sessions; other requests fork from the longest one they extend.
  let points: ClaudeSession[] = [];
  let generation = 0;
  let billingError: string | undefined;

  function terminal(q: RunningQuery, reason: AssistantMessage["stopReason"], error?: string) {
    if (!q.stream) return;
    q.output.stopReason = reason;
    if (error) q.output.errorMessage = reason === "error" ? normalizeClaudeError(error) : error;
    if (reason === "error" || reason === "aborted") {
      q.stream.push({ type: "error", reason, error: q.output });
    } else {
      q.stream.push({ type: "done", reason: reason as "stop" | "length" | "toolUse", message: q.output });
    }
    q.stream.end();
    q.stream = undefined;
  }

  function release(q: RunningQuery, reason: string, interrupt = false) {
    const query = q.query;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      query?.close();
      q.input.fail(new Error(reason));
      for (const resolve of q.handlers.values()) resolve({ content: [{ type: "text", text: reason }], isError: true });
      q.handlers.clear();
      q.results.clear();
    };
    // A stopped CLI that sees its tool calls fail goes on to another API call; interrupting it first ends the turn.
    if (interrupt && query) {
      const timer = setTimeout(settle, 2000);
      void query.interrupt().catch(() => {}).finally(() => { clearTimeout(timer); settle(); });
    } else settle();
    q.removeAbort?.();
    removeFork(q);
    running.delete(q);
  }

  function removeFork(q: RunningQuery) {
    if (q.fork?.sessionId) rmSync(getSessionPath(q.fork.sessionId, q.cwd, q.fork.configDir), { force: true });
  }

  // The state file keeps the main point and the recent points, so /tree, a restart or a fork can fork from them.
  function persist() {
    if (saved || points.length) options.save({ ...saved ?? { piSessionId: options.sessionId() }, points });
    else options.clear();
  }

  function checkpoint(q: RunningQuery, at: { size: number; tip: string }, pending?: string[]) {
    // A tool-gap point also keeps the results already handed over, in case a deliver came first.
    const delivered = pending && q.delivered.size ? { delivered: Object.fromEntries(q.delivered) } : {};
    saved = { piSessionId: options.sessionId(), sessionId: q.sessionId!, cwd: q.cwd, ...at, lastUuid: q.lastUuid, ...pending ? { pending } : {}, ...delivered };
    points = [...points.slice(-(MAX_POINTS - 1)), saved];
    persist();
  }

  // While the main query runs, its CC session is a resume point once a tool step is recorded.
  function settle(q: RunningQuery) {
    const recorded = q.expect?.gap ? q.recorded.uses : q.recorded.results;
    if (!q.expect || !q.sessionId || [...q.expect.ids].some((id) => !recorded.has(id))) return;
    const previous = saved;
    checkpoint(q, anchor(q.expect.prefix), q.expect.gap ? [...q.expect.ids] : undefined);
    if (q.expect.gap) q.gap = { point: saved!, previous, ids: [...q.expect.ids] };
    q.expect = undefined;
  }

  function stop(q: RunningQuery, error: Error, aborted = false) {
    if (q.stopped) return;
    q.stopped = true;
    if (q.gap && saved === q.gap.point) {
      points = points.filter((point) => point !== q.gap!.point);
      q.interrupted = q.gap;
      saved = q.gap.previous;
      persist();
    }
    // Keep the resume point after an abort or another error, such as a rate limit; the next turn resumes by prefix.
    // Only a rejected resume invalidates it: other requests stop forking from it, and the main conversation rebuilds.
    const loaded = q.point ?? q.cut;
    if (loaded && !q.responded && (q.failedToLoad || RESUME_FAILURE.test(error.message))) {
      failedPoints.add(loaded);
      if (q.main && saved === q.point) { saved = undefined; persist(); }
    }
    terminal(q, aborted ? "aborted" : "error", error.message);
    release(q, error.message, true);
  }

  function attach(q: RunningQuery, stream: AssistantMessageEventStream, signal?: AbortSignal) {
    q.removeAbort?.();
    q.output = outputFor(q.model);
    q.stream = stream;
    q.blocks.clear();
    q.sawMessage = false;
    q.prior = undefined;
    q.callOutput = 0;
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
    if (value.output_tokens !== undefined) q.callOutput = value.output_tokens;
    u.output = q.callOutput;
    if (value.cache_read_input_tokens !== undefined) u.cacheRead = value.cache_read_input_tokens;
    if (value.cache_creation_input_tokens !== undefined) u.cacheWrite = value.cache_creation_input_tokens;
    if (value.cache_creation?.ephemeral_1h_input_tokens !== undefined) u.cacheWrite1h = value.cache_creation.ephemeral_1h_input_tokens;
    calculateCost(q.model, u);
    // Input and cache tokens describe the context of the last call; output and cost add up.
    u.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
    if (q.prior) {
      u.output += q.prior.output;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) u.cost[key] += q.prior.cost[key];
    }
  }

  function streamEvent(q: RunningQuery, event: any, names: Map<string, string>) {
    if (!q.stream) return;
    if (event.type === "message_start") {
      if (q.sawMessage) {
        q.prior = { output: q.output.usage.output, cost: { ...q.output.usage.cost } };
        q.callOutput = 0;
      }
      q.sawMessage = true;
      q.responded = true;
      q.skipped = false;
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
        // Claude Code answers unknown tool names with its own error result, so the model can retry.
        if (!name) { q.blocks.set(event.index, null); q.skipped = true; return; }
        block = { type: "toolCall", id: b.id, name, arguments: b.input ?? {} };
        q.ids.add(b.id);
        kind = "toolcall";
      } else throw new Error(`Claude Code: unsupported content block ${b.type}`);
      const index = q.output.content.push(block) - 1;
      q.blocks.set(event.index, { index, json: "" });
      q.stream.push({ type: `${kind}_start`, contentIndex: index, partial: q.output } as any);
    } else if (event.type === "content_block_delta") {
      const entry = q.blocks.get(event.index);
      if (entry === null) return;
      if (!entry) throw new Error(`Claude Code: missing content block ${event.index}`);
      const block = q.output.content[entry.index] as any;
      const delta = event.delta;
      if (delta.type === "signature_delta") { block.thinkingSignature += delta.signature; return; }
      let kind: string;
      let text: string;
      if (delta.type === "text_delta") { kind = "text"; text = delta.text; block.text += text; }
      else if (delta.type === "thinking_delta") { kind = "thinking"; text = delta.thinking; block.thinking += text; }
      else if (delta.type === "input_json_delta") { kind = "toolcall"; text = delta.partial_json; entry.json += text; }
      else throw new Error(`Claude Code: unsupported content delta ${delta.type}`);
      q.stream.push({ type: `${kind}_delta`, contentIndex: entry.index, delta: text, partial: q.output } as any);
    } else if (event.type === "content_block_stop") {
      const entry = q.blocks.get(event.index);
      if (!entry) return;
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
      // With a skipped tool use, the gap lacks Claude Code's result for it; the results checkpoint follows.
      if (q.main && !q.skipped) { q.expect = { ids: new Set(q.ids), prefix: hashes(q.history), gap: true }; settle(q); }
      terminal(q, "toolUse");
      // Nothing continues a replay, so close it rather than leave its CLI waiting for results.
      if (q.replay) stop(q, new Error("Claude Code replay ended at a tool call"), true);
    }
  }

  async function consume(q: RunningQuery, names: Map<string, string>) {
    try {
      for await (const message of q.query!) {
        if (q.stopped) return;
        if (message.type === "rate_limit_event" && (message.rate_limit_info.isUsingOverage === true
          || message.rate_limit_info.errorCode === "credits_required")) {
          throw new Error(USAGE_CREDITS_ERROR);
        }
        if (message.type === "rate_limit_event") q.limitRejected = message.rate_limit_info.status === "rejected";
        if (message.type === "system" && message.subtype === "init") {
          q.initialized = true;
          q.sessionId = message.session_id;
          if (q.fork) q.fork.sessionId = message.session_id;
        }
        if (message.type === "user" && !message.parent_tool_use_id && message.uuid && Array.isArray(message.message.content)) {
          const ids = message.message.content.flatMap((b: any) => b.type === "tool_result" ? [b.tool_use_id] : []);
          if (ids.length) { q.lastUuid = message.uuid; for (const id of ids) q.recorded.results.add(id); settle(q); }
        }
        if (message.type === "assistant") {
          q.lastUuid = message.uuid;
          for (const b of message.message?.content ?? []) if (b.type === "tool_use") q.recorded.uses.add(b.id);
          settle(q);
          if (message.error) {
            const detail = message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
            throw new Error(typedClaudeError(message.error, detail, q.limitRejected === true));
          }
          // Completed assistant records echo the stream; they must never duplicate tool calls.
        }
        if (message.type === "stream_event" && !message.parent_tool_use_id) streamEvent(q, message.event, names);
        if (message.type === "result") {
          if (message.subtype !== "success" || message.is_error) {
            q.failedToLoad = !q.initialized;
            throw new Error(message.subtype === "success" ? message.result : message.errors.join("\n"));
          }
          if (!q.stream || !q.sawMessage) throw new Error("Claude Code finished without a complete streamed response");
          q.history.push(structuredClone(q.output));
          if (q.main && q.sessionId) checkpoint(q, anchor(hashes(q.history)));
          options.trace?.(`completed cacheRead=${q.output.usage.cacheRead} cacheWrite=${q.output.usage.cacheWrite} input=${q.output.usage.input}`);
          q.stopped = true;
          release(q, "Claude Code query completed");
          terminal(q, q.output.stopReason === "length" ? "length" : "stop");
          return;
        }
      }
      if (!q.stopped) throw new Error("Claude Code stream ended without a result");
    } catch (error) {
      const message = queryError(error);
      if (message.startsWith(USAGE_CREDITS_ERROR)) {
        // A rate-limit event can arrive after toolUse ended the Pi stream.
        // Block rebuilding that query on the next tool-result continuation.
        billingError = message;
        for (const active of [...running]) stop(active, new Error(message));
      } else stop(q, new Error(message));
    } finally {
      // Leaving the loop waits for the CLI to exit, after it wrote its final records to the fork.
      removeFork(q);
      reanchor(q);
    }
  }

  // Claude Code answers the tool uses of a stopped query with an interrupted result, which resumes.
  function reanchor(q: RunningQuery) {
    const gap = q.interrupted;
    if (!gap || q.generation !== generation || saved !== gap.previous || !q.sessionId) return;
    const uuid = interruption(q.sessionId, q.cwd, q.configDir, gap.ids);
    if (!uuid) return;
    q.lastUuid = uuid;
    checkpoint(q, { size: gap.point.size, tip: gap.point.tip });
    saved!.answered = true;
    if (q.delivered.size) saved!.delivered = Object.fromEntries(q.delivered);
    persist();
  }

  async function start(model: Model<any>, context: TranscriptContext, request: SimpleStreamOptions, stream: AssistantMessageEventStream) {
    request.signal?.throwIfAborted();
    if (billingError) throw new Error(billingError);
    if (request.fetch) throw new Error("Claude Code uses an SDK subprocess and cannot accept a custom fetch");
    // Like Pi's native Anthropic path, later system messages stay in place when the model accepts them;
    // the prompt comes from the leading one, so a patch appends to the history instead of changing the prefix.
    const transcript = resolveTranscript(context, (model.compat as any)?.supportsMidConvoSystemMessages);
    const system = getInitialSystemMessage(transcript.messages);
    const originalPrompt = system ? getSystemMessageText(system) : "";
    const payload = {
      messages: system ? transcript.messages.slice(1) : transcript.messages,
      tools: request.toolChoice === "none" ? [] : getCurrentTools(context.messages),
      systemPrompt: originalPrompt,
      reasoning: request.reasoning,
      maxTokens: request.maxTokens ?? model.maxTokens,
    };
    const startedGeneration = generation;
    const effective = (await request.onPayload?.(payload, model) ?? payload) as typeof payload;
    const { reasoning, maxTokens } = effective;
    // Like pi-ai's transformMessages, incomplete turns are never replayed.
    const messages = effective.messages.filter((m) =>
      m.role !== "assistant" || (m.stopReason !== "aborted" && m.stopReason !== "error"));
    const tools = effective.tools.slice().sort((a, b) => a.name.localeCompare(b.name));
    const names = new Map(tools.map((tool) => [`mcp__pi__${tool.name}`, tool.name]));
    const systemPrompt = effective.systemPrompt === originalPrompt
      ? await buildClaudeSystemPrompt(system, names)
      : effective.systemPrompt;
    request.signal?.throwIfAborted();
    if (generation !== startedGeneration) throw new Error("Pi session context changed before the request started");
    if (billingError) throw new Error(billingError);
    const env = subscriptionEnvironment(request);
    const configuration = digest([model.id, systemPrompt, tools, reasoning, maxTokens, request.thinkingBudgets, request.env, request.headers, request.cacheRetention]);
    const incoming = hashes(messages), tips = chain(incoming);
    const resultIds = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
    // Replays such as cache warming must neither continue nor record the main conversation.
    const side = (request as { disableContinuation?: boolean }).disableContinuation === true;
    const owner = side ? undefined : [...running].find((q) => !q.stream && q.requester === request.sessionId
      && [...q.ids].some((id) => resultIds.has(id)));
    if (owner && owner.configuration === configuration && startsWith(incoming, hashes(owner.history))
      && messages.every((m) => m.role !== "toolResult" || !owner.delivered.has(m.toolCallId)
        || owner.delivered.get(m.toolCallId) === resultDigest(m.content, m.isError))) {
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
      owner.expect = owner.main && !delta.some(isInput) ? { ids: new Set(results.map((m) => m.toolCallId)), prefix: incoming, gap: false } : undefined;
      // The stdin write must precede releasing MCP results, so steering reaches this turn.
      for (const message of convertPiMessages(delta.filter(isInput)).anthropicMessages) {
        await owner.input.push(userMessage(message.content as any, "next"));
      }
      owner.ids.clear();
      for (const message of results) {
        if (owner.delivered.has(message.toolCallId)) continue;
        const result = { content: toolResultToMcpContent(message.content), isError: message.isError };
        const resolve = owner.handlers.get(message.toolCallId);
        if (resolve) { owner.handlers.delete(message.toolCallId); resolve(result); }
        else owner.results.set(message.toolCallId, result);
      }
      return;
    }
    if (owner) stop(owner, new Error("Pi context changed; rebuilding Claude Code context"));

    const main = !side && request.sessionId === options.sessionId() && ![...running].some((q) => q.main);
    const cwd = options.cwd();
    let promptMessages = messages;
    let prefixCut: ClaudeSession | undefined;
    let resume: string | undefined;
    let resumeSessionAt: string | undefined;
    let fork = false;
    const usable = (point: ClaudeSession) => point.cwd === cwd && continues(point, messages, tips)
      && existsSync(getSessionPath(point.sessionId, cwd, request.env?.CLAUDE_CONFIG_DIR));
    let point = main && saved?.piSessionId === options.sessionId() && usable(saved) ? saved : undefined;
    // Requests that extend a main history at an earlier or another Session's point fork that CC session
    // to reuse its prompt cache; for this Session's main conversation, the fork becomes its own session.
    if (!point) {
      fork = true;
      point = [...points, ...options.forkSources()].sort((a, b) => b.size - a.size)
        .find((candidate) => !failedPoints.has(candidate) && usable(candidate));
    }
    if (point) {
      promptMessages = unseen(point, messages);
      resume = point.sessionId;
      resumeSessionAt = point.lastUuid;
      options.trace?.(fork ? "fork: unchanged main history" : "resume: unchanged history");
    } else {
      fork = false;
      // Import only into a new, bridge-owned session. Never overwrite another session's history.
      const split = messages.findLastIndex((m) => !isInput(m)) + 1;
      const history = messages.slice(0, split);
      promptMessages = messages.slice(split);
      // The longest point the history still extends is kept verbatim; only the changed tail is imported.
      const cut = main ? [...points, ...options.forkSources()].sort((a, b) => b.size - a.size).find((candidate) =>
        candidate.size > 0 && candidate.size < split && !candidate.answered && !failedPoints.has(candidate)
        && candidate.cwd === cwd && extendsPoint(candidate, tips) && !endsWithToolCalls(messages[candidate.size - 1])) : undefined;
      const prefixed = cut && writePrefixSession(cut, history.slice(cut.size), model.id, request.env?.CLAUDE_CONFIG_DIR);
      if (prefixed) {
        resume = prefixed;
        prefixCut = cut;
        options.trace?.("prefix: Pi history changed after a resume point");
      } else if (history.length) {
        const session = createSession({ projectPath: cwd, model: model.id, claudeDir: request.env?.CLAUDE_CONFIG_DIR });
        const { anthropicMessages } = convertPiMessages(history);
        session.importMessages(anthropicMessages);
        session.save();
        resume = session.sessionId;
        options.trace?.("rebuild: Pi history changed or no saved session");
      } else options.trace?.("start: empty history");
    }
    const { anthropicMessages } = convertPiMessages(promptMessages);
    if (anthropicMessages.some((m) => m.role !== "user")) throw new Error("Claude Code resume suffix contains non-user history");
    const prompt = anthropicMessages.flatMap((m) => typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content);
    const input = makePromptStream();
    const q: RunningQuery = {
      input, output: outputFor(model), model, history: structuredClone(messages), configuration,
      ids: new Set(), handlers: new Map(), results: new Map(), blocks: new Map(),
      cwd, main, stopped: false, sawMessage: false, callOutput: 0, recorded: { uses: new Set(), results: new Set() }, delivered: new Map(), requester: request.sessionId, point, cut: prefixCut, replay: side, sessionId: resume,
      configDir: request.env?.CLAUDE_CONFIG_DIR, generation,
      // A side fork gets its id up front, so its file can be removed even before the CLI reports it.
      ...(fork && !main ? { fork: { configDir: request.env?.CLAUDE_CONFIG_DIR, sessionId: randomUUID() } } : {}),
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
      // Claude Code omits thinking text unless asked for summaries.
      if (adaptive) thinking = { type: "adaptive", display: "summarized" };
      else {
        const level = reasoning === "xhigh" || reasoning === "max" ? "high" : reasoning;
        const budget = Math.max(1024, request.thinkingBudgets?.[level] ?? { minimal: 1024, low: 2048, medium: 8192, high: 16384 }[level]);
        outputTokens = Math.min(model.maxTokens, Math.max(maxTokens, 1024) + budget);
        thinking = { type: "enabled", budgetTokens: Math.min(budget, Math.max(0, outputTokens - 1024)), display: "summarized" };
      }
    }
    const sdkOptions: Options = {
      cwd, model: model.id, tools: [], mcpServers: tools.length ? { pi: server } : {},
      allowedTools: [...names.keys()], permissionMode: "dontAsk",
      systemPrompt, includePartialMessages: true,
      settingSources: [], skills: [], settings: { autoMemoryEnabled: false, claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**"] },
      env: { ...env,
        CLAUDE_CODE_MAX_RETRIES: "0",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "0",
        ENABLE_TOOL_SEARCH: "false", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(outputTokens),
        ...(request.cacheRetention === "none" ? { DISABLE_PROMPT_CACHING: "1" } : {}),
      },
      extraArgs: { "strict-mcp-config": null },
      ...(mappedEffort && adaptive ? { effort: mappedEffort as Options["effort"] } : {}),
      thinking,
      ...(resume ? { resume, resumeSessionAt, ...(fork ? { forkSession: true, ...(q.fork ? { sessionId: q.fork.sessionId } : {}) } : {}) } : { persistSession: main }),
    };
    let consuming = false;
    try {
      q.query = runQuery({ prompt: input.stream, options: sdkOptions });
      const account = await q.query.accountInfo();
      if (q.stopped) return;
      if (account.apiProvider !== "firstParty" || !account.subscriptionType
        || (account.apiKeySource && !["none", "oauth"].includes(account.apiKeySource))) {
        throw new Error("Claude Code billing: this provider requires a first-party subscription login. Run `claude auth login` with your Claude subscription account.");
      }
      void input.push(userMessage(prompt.length ? prompt as any : "Continue from the conversation and tool results above."))
        .catch((error) => { if (!q.stopped) stop(q, new Error(queryError(error))); });
      consuming = true;
      void consume(q, names);
    } catch (error) {
      stop(q, new Error(queryError(error)));
    } finally {
      // Without consume, wait here for the CLI to exit before removing a fork it created.
      if (!consuming && q.fork) void Promise.resolve(q.query?.return(undefined)).catch(() => {}).finally(() => removeFork(q));
    }
  }

  return {
    streamSimple(model: Model<any>, context: TranscriptContext, request: SimpleStreamOptions = {}) {
      const stream = createAssistantMessageEventStream();
      void start(model, context, request, stream).catch((error) => {
        const owner = [...running].find((q) => q.stream === stream);
        if (owner) { stop(owner, error instanceof Error ? error : new Error(String(error)), request.signal?.aborted); return; }
        const output = outputFor(model);
        output.stopReason = request.signal?.aborted ? "aborted" : "error";
        output.errorMessage = normalizeClaudeError(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      });
      return stream;
    },
    // Load this Session's state; a forked Session also inherits its parent's points.
    restore(state?: BridgeState, inherited: ClaudeSession[] = []) {
      const { points: stored, ...top } = state ?? {};
      let own = top.sessionId ? migrate(top as ClaudeSession) : undefined;
      // Pi exited at a tool gap without withdrawing it: resume at Claude Code's interrupted result, or rebuild.
      if (own?.pending) {
        const uuid = interruption(own.sessionId, own.cwd, undefined, own.pending);
        const { pending: _pending, ...rest } = own;
        own = uuid ? { ...rest, lastUuid: uuid, answered: true } : undefined;
      }
      const kept = (stored ?? []).map(migrate).filter((point) => !point.pending && !(own && samePoint(point, own)));
      saved = own;
      points = [...inherited, ...kept, ...own ? [own] : []].slice(-MAX_POINTS);
      // Rewrite a state that was re-anchored or still uses the old point format.
      if (state?.pending || (state as { prefix?: unknown } | undefined)?.prefix) persist();
    },
    points: () => points,
    // Hand a finished tool's result to Claude Code at once, so an abort later in the batch keeps it.
    // The batch's last result waits for Pi's continuation request, which writes steering input first.
    deliver(toolCallId: string, content: any[], isError: boolean) {
      const q = [...running].find((candidate) => !candidate.stream && candidate.ids.has(toolCallId));
      if (!q || q.delivered.has(toolCallId)) return;
      if ([...q.ids].every((id) => id === toolCallId || q.delivered.has(id))) return;
      q.delivered.set(toolCallId, resultDigest(content, isError));
      if (q.gap && saved === q.gap.point) {
        saved.delivered = Object.fromEntries(q.delivered);
        persist();
      }
      const result = { content: toolResultToMcpContent(content), isError };
      const resolve = q.handlers.get(toolCallId);
      if (resolve) { q.handlers.delete(toolCallId); resolve(result); }
      else q.results.set(toolCallId, result);
    },
    // /tree: stop the running queries, but keep the points the new branch may fork from.
    navigate() {
      generation++;
      for (const q of [...running]) stop(q, new Error("Pi session context changed"), true);
    },
    reset() {
      generation++;
      // Stopping first lets a query at a tool gap withdraw its persisted checkpoint.
      for (const q of [...running]) stop(q, new Error("Pi session context changed"), true);
      saved = undefined;
      points = [];
    },
  };
}
