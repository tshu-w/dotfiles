import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonObject, JsonValue, Message } from "@earendil-works/pi-ai";

export const MAX_PROMPT_TEXT_BYTES = 185_000;
// Revision covers turn boundaries, omission counts and marker formatting.
export const HISTORY_IMPORT_POLICY = { revision: 4, maxBytes: 500_000 } as const;

// Native agy 1.5.15 schema. The caller gates the CLI version, creates a fresh
// session, stops its creator, and supplies its file identity in the shared profile.
// This module never starts agy or writes shared conversation indexes.
// Validate whole histories before windowing; signatures/thinking are excluded.
type TextStep = { role: "user" | "assistant"; text: string };
type Call = { id: string; name: string; arguments: JsonObject };
export type PreparedHistory = readonly (TextStep | { role: "image"; text: string; data: string } | { role: "call"; calls: Call[]; text?: string } | { role: "result"; call: Call; text: string; isError: boolean })[];

export type ImportLosses = {
  userTruncated: number;
  toolResultsTruncated: number;
  earlierMessagesOmitted: number;
  intermediateMessagesOmitted: number;
  toolImagesOmitted: number;
};

export function formatOmission(count: number, unit: "byte" | "earlier message" | "intermediate message"): string {
  return `[Pi omitted ${count} ${unit}${count === 1 ? "" : "s"}]`;
}

function resultTextLimit(isError: boolean): number {
  return 48 * 1024 - (isError ? Buffer.byteLength("Encountered error in tool execution: ") : 0);
}

// JSON encoding must not replace strings or normalize numeric values.
function losslessJson(value: JsonValue): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (value === null || typeof value === "boolean") return true;
  return Array.isArray(value) ? value.every(losslessJson)
    : Object.entries(value).every(([key, item]) => key.isWellFormed() && losslessJson(item));
}

// Bound only the target copy, keeping the source tail (including Pi continuation
// notices), exact omitted bytes and complete UTF-8 characters.
function truncateText(text: string, limit: number): string {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const bytes = Buffer.from(text, "utf8");
  // The total byte count reserves enough digits for the smaller omitted count.
  const budget = limit - Buffer.byteLength(`\n\n${formatOmission(bytes.length, "byte")}\n\n`);
  let head = Math.floor(budget / 2), tail = bytes.length - Math.ceil(budget / 2);
  while ((bytes[head] & 0xc0) === 0x80) head--;
  while ((bytes[tail] & 0xc0) === 0x80) tail++;
  return bytes.subarray(0, head).toString("utf8") + `\n\n${formatOmission(tail - head, "byte")}\n\n` + bytes.subarray(tail).toString("utf8");
}

// User images require [Text, PNG]. Completed call batches retain one planner step
// and adjacent, ID-matched results normalized to call order in the target only.
// Native MCP joins result text blocks with LF;
// tool-result images become explicit placeholders before target-only truncation.
export function prepareHistory(messages: readonly Message[], promptTextBytes = 0): { steps: PreparedHistory; losses: ImportLosses } | undefined {
  const steps: (PreparedHistory[number])[] = [];
  const truncatedSources = new Set<number>();
  const turns: { sourceIndex: number; stepIndex: number; texts: string[] }[] = [];
  const groups: { sourceIndex: number; stepIndex: number }[] = [];
  const pairedIds = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "user") {
      if (typeof message.content === "string") steps.push({ role: "user", text: message.content });
      else if (message.content.length === 1 && message.content[0].type === "text") steps.push({ role: "user", text: message.content[0].text });
      else if (message.content.length === 2 && message.content[0].type === "text" && message.content[1].type === "image" && message.content[1].mimeType === "image/png") {
        const data = message.content[1].data;
        const bytes = Buffer.from(data, "base64");
        if (bytes.toString("base64") !== data || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return undefined;
        steps.push({ role: "image", text: message.content[0].text, data });
      } else return undefined;
      if (index === 0 || messages[index - 1].role !== "user") {
        turns.push({ sourceIndex: index, stepIndex: steps.length - 1, texts: [] });
      }
      const originalText = steps[steps.length - 1].text!;
      turns[turns.length - 1].texts.push(originalText);
      if (Buffer.byteLength(originalText) > MAX_PROMPT_TEXT_BYTES) truncatedSources.add(index);
    } else if (message.role === "assistant") {
      if (message.deferred !== undefined || message.errorMessage !== undefined) return undefined;
      const visible = message.content.filter(block => block.type !== "thinking");
      if (!visible.length && message.content.length && message.stopReason === "stop") continue;
      if (!visible.length) return undefined;
      const first = visible[0];
      const group = { sourceIndex: index, stepIndex: steps.length };
      if (visible.length === 1 && first.type === "text") {
        if (message.stopReason !== "stop") return undefined;
        if (first.text === "") continue;
        steps.push({ role: "assistant", text: first.text });
      } else {
        const leading = first.type === "text" ? first.text : undefined;
        const blocks = first.type === "text" ? visible.slice(1) : visible;
        if (message.stopReason !== "toolUse" || !blocks.length || !blocks.every(block => block.type === "toolCall")) return undefined;
        const pending = new Map<string, Call>();
        for (const block of blocks) {
          if (typeof block.id !== "string" || !block.id || pairedIds.has(block.id)
            || typeof block.name !== "string" || !block.name
            || block.argumentsError !== undefined || block.namespace !== undefined) return undefined;
          let args: JsonObject;
          try {
            if (!losslessJson(block.arguments)) return undefined;
            args = structuredClone(block.arguments);
            JSON.stringify(args);
          } catch {
            return undefined;
          }
          pending.set(block.id, { id: randomUUID(), name: block.name, arguments: args });
          pairedIds.add(block.id);
        }
        const calls = [...pending.values()];
        const completed = new Map<Call, { text: string; isError: boolean }>();
        steps.push({ role: "call", calls, text: leading });
        for (let remaining = pending.size; remaining > 0; remaining--) {
          const result = messages[++index];
          if (result?.role !== "toolResult") return undefined;
          const call = pending.get(result.toolCallId);
          if (!call || result.toolName !== call.name || typeof result.isError !== "boolean"
            || !result.content.length || !result.content.every(block => block.type === "text" || block.type === "image")) return undefined;
          const text = result.content.map(block => block.type === "text" ? block.text : "[Pi omitted an image]").join("\n");
          if (Buffer.byteLength(text) > resultTextLimit(result.isError)) truncatedSources.add(index);
          completed.set(call, { text, isError: result.isError });
          pending.delete(result.toolCallId);
        }
        for (const call of calls) steps.push({ role: "result", call, ...completed.get(call)! });
      }
      if (steps[group.stepIndex].role === "call" || steps[group.stepIndex].text) groups.push(group);
    } else return undefined;
  }
  // UTF-8 encoding replaces lone UTF-16 surrogates; reject rather than alter text.
  if (steps.some(step => ("text" in step && step.text !== undefined && !step.text.isWellFormed())
    || ("call" in step && !step.call.name.isWellFormed()))) return undefined;
  for (const step of steps) if (step.role === "user" || step.role === "image" || step.role === "result") {
    // Native adds the error prefix before applying its own 48 KiB result limit.
    const limit = step.role === "result"
      ? resultTextLimit(step.isError) : MAX_PROMPT_TEXT_BYTES;
    step.text = truncateText(step.text, limit);
  }
  if (!steps.length) return undefined;
  // Count only the final retained source ranges, never unsuccessful candidates.
  const finish = (retained: PreparedHistory, earlier = 0, middleStart = 0, middleEnd = 0) => {
    const losses: ImportLosses = { userTruncated: 0, toolResultsTruncated: 0,
      earlierMessagesOmitted: earlier, intermediateMessagesOmitted: middleEnd - middleStart, toolImagesOmitted: 0 };
    for (let index = earlier; index < messages.length; index++) {
      if (index >= middleStart && index < middleEnd) continue;
      const message = messages[index];
      if (message.role === "user" && truncatedSources.has(index)) losses.userTruncated++;
      if (message.role === "toolResult") {
        if (truncatedSources.has(index)) losses.toolResultsTruncated++;
        losses.toolImagesOmitted += message.content.filter(block => block.type === "image").length;
      }
    }
    return { steps: retained, losses };
  };
  // Count projected text and each call's JSON arguments once, not names, IDs,
  // image data, native framing or the native error prefix.
  const sizes = steps.map(step => Buffer.byteLength(step.text ?? "") + (step.role === "call"
    ? step.calls.reduce((sum, call) => sum + Buffer.byteLength(JSON.stringify(call.arguments)), 0) : 0));
  let remainingBytes = promptTextBytes + sizes.reduce((sum, size) => sum + size, 0);
  if (remainingBytes <= HISTORY_IMPORT_POLICY.maxBytes) return finish(steps);
  let omittedSteps = 0;
  for (const turn of turns) {
    if (!turn.sourceIndex) continue;
    while (omittedSteps < turn.stepIndex) remainingBytes -= sizes[omittedSteps++];
    // Reproject the original user text, never an already truncated copy.
    const markedInput = `${formatOmission(turn.sourceIndex, "earlier message")}\n\n${turn.texts[0]}`;
    const markedText = truncateText(markedInput, MAX_PROMPT_TEXT_BYTES);
    if (remainingBytes - sizes[turn.stepIndex] + Buffer.byteLength(markedText) <= HISTORY_IMPORT_POLICY.maxBytes) {
      const retained = steps.slice(turn.stepIndex);
      retained[0] = { ...retained[0], text: markedText };
      if (Buffer.byteLength(markedInput) > MAX_PROMPT_TEXT_BYTES) truncatedSources.add(turn.sourceIndex);
      return finish(retained, turn.sourceIndex);
    }
  }
  // Keep the latest user run and at least its last visible assistant group.
  // Mark the middle gap in existing user text, never by inventing a user turn.
  const turn = turns.at(-1);
  if (turn) {
    const userEnd = turn.sourceIndex + turn.texts.length;
    const latestGroups = groups.filter(group => group.sourceIndex >= userEnd);
    for (const group of latestGroups.slice(1)) {
      while (omittedSteps < group.stepIndex) remainingBytes -= sizes[omittedSteps++];
      const markedTruncations: number[] = [];
      const users = turn.texts.map((text, index) => {
        const head = index === 0 && turn.sourceIndex ? `${formatOmission(turn.sourceIndex, "earlier message")}\n\n` : "";
        const tail = index === turn.texts.length - 1 ? `\n\n${formatOmission(group.sourceIndex - userEnd, "intermediate message")}\n\n` : "";
        const markedInput = head + text + tail;
        if (Buffer.byteLength(markedInput) > MAX_PROMPT_TEXT_BYTES) markedTruncations.push(turn.sourceIndex + index);
        return { ...steps[turn.stepIndex + index], text: truncateText(markedInput, MAX_PROMPT_TEXT_BYTES) };
      });
      if (remainingBytes + users.reduce((sum, user) => sum + Buffer.byteLength(user.text), 0) <= HISTORY_IMPORT_POLICY.maxBytes) {
        for (const index of markedTruncations) truncatedSources.add(index);
        return finish([...users, ...steps.slice(group.stepIndex)], turn.sourceIndex, userEnd, group.sourceIndex);
      }
    }
  }
  throw new Error("Antigravity cannot fit the latest turn. Compact with another model or start a new conversation.");
}

function varint(value: number): Buffer {
  let n = BigInt(value);
  const bytes: number[] = [];
  do { const byte = Number(n & 127n); n >>= 7n; bytes.push(byte | (n ? 128 : 0)); } while (n);
  return Buffer.from(bytes);
}
function field(number: number, value: number | string | Buffer): Buffer {
  if (typeof value === "number") return Buffer.concat([varint(number * 8), varint(value)]);
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
const messageField = (number: number, fields: Buffer[]) => field(number, Buffer.concat(fields));

const stepColumns = "idx:INTEGER:1:0,step_type:INTEGER:0:1,status:INTEGER:0:1,has_subtrajectory:NUMERIC:0:1,metadata:BLOB:0:0,error_details:BLOB:0:0,permissions:BLOB:0:0,task_details:BLOB:0:0,render_info:BLOB:0:0,step_payload:BLOB:0:0,step_format:INTEGER:0:1";
const identityColumns = "trajectory_id:TEXT:1:0,cascade_id:TEXT:0:0,trajectory_type:INTEGER:0:0,source:INTEGER:0:0";
const emptyTables = ["steps", "gen_metadata", "executor_metadata", "parent_references", "battle_mode_infos"];
function emptyTarget(db: DatabaseSync, sessionId: string): string | undefined {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  if (JSON.stringify(tables) !== JSON.stringify([...emptyTables, "trajectory_meta", "trajectory_metadata_blob"].sort())) return undefined;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' LIMIT 1").get()) return undefined;
  const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map(row => `${row.name}:${String(row.type).toUpperCase()}:${row.pk}:${row.notnull}`).join(",");
  if (columns("steps") !== stepColumns || columns("trajectory_meta") !== identityColumns
    || columns("trajectory_metadata_blob") !== "id:TEXT:1:0,data:BLOB:0:0") return undefined;
  if (emptyTables.some(table => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) return undefined;
  const identities = db.prepare("SELECT * FROM trajectory_meta").all();
  if (identities.length !== 1) return undefined;
  const identity = identities[0];
  if (identity.cascade_id !== sessionId || identity.trajectory_type !== 4 || identity.source !== 17
    || typeof identity.trajectory_id !== "string" || !identity.trajectory_id) return undefined;
  const metadata = db.prepare("SELECT id, data FROM trajectory_metadata_blob").all();
  if (metadata.length !== 1 || metadata[0].id !== "main" || !(metadata[0].data instanceof Uint8Array) || !metadata[0].data.length) return undefined;
  return identity.trajectory_id;
}

// Image authority is explicit and restricted to this native target's upload directory.
// Ordinary failures remove only files created here; empty directories may remain.
// SQLite/files are not crash-atomic; never remove native DBs or shared profile trees.
// Operational failures propagate; cleanup must not replace the original error.
export function writeHistory(targetDatabasePath: string, sessionId: string, prepared: PreparedHistory, imageDirectory: string | undefined, expectedIdentity: { dev: number; ino: number }): boolean {
  let db: DatabaseSync | undefined;
  const createdImages: string[] = [];
  let committed = false, failed = false;
  try {
    const matchesTarget = () => {
      const stat = lstatSync(targetDatabasePath, { throwIfNoEntry: false });
      return stat?.isFile() && stat.nlink === 1 && stat.dev === expectedIdentity.dev && stat.ino === expectedIdentity.ino
        && realpathSync(targetDatabasePath) === targetDatabasePath;
    };
    if (!prepared.length || !sessionId || !matchesTarget()) return false;
    db = new DatabaseSync(targetDatabasePath);
    db.exec("BEGIN IMMEDIATE");
    if (!matchesTarget()) return false;
    const trajectoryId = emptyTarget(db, sessionId);
    if (!trajectoryId) return false;
    if (prepared.some(step => step.role === "image")) {
      const database = resolve(targetDatabasePath), profile = dirname(dirname(database));
      if (database !== join(profile, "conversations", sessionId + ".db") || !imageDirectory
        || resolve(imageDirectory) !== join(profile, "brain", sessionId, ".user_uploaded")) return false;
      imageDirectory = resolve(imageDirectory);
      for (const directory of [join(profile, "brain"), join(profile, "brain", sessionId), imageDirectory]) {
        if (!lstatSync(directory, { throwIfNoEntry: false })) mkdirSync(directory);
        if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) return false;
      }
    }
    const insert = db.prepare("INSERT INTO steps (idx,step_type,status,has_subtrajectory,metadata,error_details,step_payload,step_format) VALUES (?,?,?,0,?,?,?,0)");
    const runId = randomUUID();
    for (const [idx, step] of prepared.entries()) {
      const type = step.role === "user" || step.role === "image" ? 14 : step.role === "result" ? 132 : 15;
      const stamp = () => [field(1, Math.floor(Date.now() / 1000))];
      const calls = step.role === "call" ? step.calls : step.role === "result" ? [step.call] : [];
      const callFields = calls.map(call => [field(1, call.id), field(2, `mcp_pi_${call.name}`), field(3, JSON.stringify(call.arguments))]);
      const metadataFields = [
        messageField(1, stamp()), field(3, type === 14 ? 4 : 2), field(12, runId),
        messageField(20, [field(1, trajectoryId), field(2, idx), field(4, sessionId)]), field(35, randomBytes(16).toString("hex")),
      ];
      if (step.role === "result") metadataFields.push(messageField(4, callFields[0]), messageField(6, stamp()), messageField(7, stamp()), messageField(8, stamp()));
      const metadata = Buffer.concat(metadataFields);
      const error = step.role === "result" && step.isError ? Buffer.concat([field(2, step.text), field(3, step.text)]) : undefined;
      const status = error ? 7 : 3;
      let body: Buffer;
      if (step.role === "user" || step.role === "image") {
        const fields = [field(2, step.text), messageField(3, [field(1, step.text)]), field(4, "")];
        if (step.role === "image") {
          const path = join(imageDirectory!, `pi-history-${randomUUID()}.png`);
          const bytes = Buffer.from(step.data, "base64");
          const fd = openSync(path, "wx", 0o600);
          createdImages.push(path);
          let written = false;
          try { writeFileSync(fd, bytes); written = true; }
          finally { try { closeSync(fd); } catch (error) { if (written) throw error; } }
          fields.push(messageField(9, [field(1, "image/png"), field(2, bytes), field(5, path)]));
        }
        body = messageField(19, fields);
      } else if (step.role === "assistant") body = messageField(20, [field(1, step.text), field(8, step.text), field(12, 2)]);
      else if (step.role === "call") body = messageField(20, [
        ...(step.text === undefined ? [] : [field(1, step.text)]), ...callFields.map(fields => messageField(7, fields)),
        ...(step.text === undefined ? [] : [field(8, step.text)]), field(12, 2),
      ]);
      else body = Buffer.concat([
        messageField(133, [messageField(2, [messageField(1, [field(1, "mcp"), field(2, `pi/${step.call.name}`)]), field(2, 1), field(5, "mcp"), field(6, `pi/${step.call.name}`)])]),
        messageField(140, [
          // Native 140->1 uses raw strings, empty text for null, JSON for other values.
          ...Object.entries(step.call.arguments).map(([key, value]) => messageField(1, [field(1, key), field(2, value === null ? "" : typeof value === "string" ? value : JSON.stringify(value))])),
          messageField(2, step.isError ? [] : [field(1, step.text)]),
        ]),
      ]);
      const payload = Buffer.concat([field(1, type), field(4, status), field(5, metadata), ...(error ? [field(31, error)] : []), body]);
      insert.run(idx, type, status, metadata, error ?? null, payload);
    }
    db.exec("COMMIT");
    committed = true;
    return true;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let cleanupError: unknown;
    try { if (db?.isTransaction) db.exec("ROLLBACK"); } catch (error) { cleanupError = error; }
    try { db?.close(); } catch (error) { cleanupError ??= error; }
    if (!committed) for (const path of createdImages) {
      try { unlinkSync(path); } catch (error) { cleanupError ??= error; }
    }
    if (!failed && cleanupError !== undefined) throw cleanupError;
  }
}
