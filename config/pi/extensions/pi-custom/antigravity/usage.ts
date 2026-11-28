import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type NativeGenerationUsage = { index: number; input: number; output: number; cacheRead: number; cacheWrite: number };
export type NativeContextIntegrity = { status: "intact" | "unknown" }
  | { status: "truncated"; generationIndex: number; reason: "max_token_limit" };
export type NativeUsageSnapshot = Omit<NativeGenerationUsage, "index"> & {
  generationIndex: number;
  totalTokens: number;
  generations: NativeGenerationUsage[];
  contextIntegrity: NativeContextIntegrity;
};
type Field = { wire: number; value: bigint | Buffer };
type Fields = Map<number, Field[]>;
const unavailable = (): never => { throw new Error("Antigravity native usage unavailable"); };
function parse(bytes: Uint8Array): Fields {
  if (!(bytes instanceof Uint8Array)) unavailable();
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), fields: Fields = new Map();
  let offset = 0;
  const varint = () => {
    let result = 0n;
    for (let count = 0; count < 10; count++) {
      if (offset >= data.length) unavailable();
      const byte = data[offset++];
      result |= BigInt(byte & 127) << BigInt(count * 7);
      if (!(byte & 128)) { if (result > 0xffffffffffffffffn) unavailable(); return result; }
    }
    return unavailable();
  };
  while (offset < data.length) {
    const key = varint(), number = Number(key >> 3n), wire = Number(key & 7n);
    if (number < 1 || number > 0x1fffffff) unavailable();
    let value: bigint | Buffer;
    if (wire === 0) value = varint();
    else {
      const length = wire === 2 ? varint() : wire === 1 ? 8n : wire === 5 ? 4n : unavailable();
      if (length > BigInt(data.length - offset)) unavailable();
      value = data.subarray(offset, offset + Number(length)); offset += Number(length);
    }
    const items = fields.get(number) ?? []; items.push({ wire, value }); fields.set(number, items);
  }
  return fields;
}
function scalar(fields: Fields, number: number, wire: number): bigint | Buffer | undefined {
  const items = fields.get(number) ?? [];
  if (items.length > 1 || items.some(item => item.wire !== wire)) unavailable();
  return items[0]?.value;
}
function child(fields: Fields, number: number): Fields {
  const value = scalar(fields, number, 2);
  if (!(value instanceof Uint8Array)) unavailable();
  return parse(value);
}
function counter(fields: Fields, number: number): number {
  const value = scalar(fields, number, 0) ?? 0n;
  if (typeof value !== "bigint" || value > BigInt(Number.MAX_SAFE_INTEGER)) unavailable();
  return Number(value);
}
function contextEvidence(fields: Fields, usage: NativeGenerationUsage, verified?: string): { context: NativeContextIntegrity; witness?: string } {
  try {
    // CortexStepGeneratorMetadata.chat_model -> chat_start_metadata ->
    // context_window_metadata. Only MAX_TOKEN_LIMIT has calibrated loss evidence.
    const context = child(child(child(fields, 1), 9), 10);
    const reason = counter(context, 2);
    if (reason === 2) return { context: { status: "truncated", generationIndex: usage.index, reason: "max_token_limit" } };
    if (reason !== 0) return { context: { status: "unknown" } };
    const estimated = counter(context, 1), maximum = counter(context, 4);
    const validCount = (value: number) => value >= 0 && value <= 0x7fffffff;
    if (!validCount(estimated) || !validCount(maximum) || estimated === 0 || maximum === 0 || estimated > maximum)
      return { context: { status: "unknown" } };
    const witness = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, estimated, maximum].join(":");
    // Native storage can discard an older generation's breakdown. Retain only
    // evidence already verified for that generation with unchanged counters.
    if (!context.has(3)) return witness === verified
      ? { context: { status: "intact" } } : { context: { status: "unknown" } };
    const breakdown = child(context, 3);
    if (counter(breakdown, 2) !== estimated) return { context: { status: "unknown" } };
    let sum = 0;
    for (const group of breakdown.get(1) ?? []) {
      if (group.wire !== 2 || !Buffer.isBuffer(group.value)) return { context: { status: "unknown" } };
      const count = counter(parse(group.value), 4);
      if (!validCount(count)) return { context: { status: "unknown" } };
      sum += count;
      if (!Number.isSafeInteger(sum)) return { context: { status: "unknown" } };
    }
    return sum === estimated ? { context: { status: "intact" }, witness } : { context: { status: "unknown" } };
  } catch { return { context: { status: "unknown" } }; }
}
function indices(fields: Fields): number[] {
  const result: number[] = [];
  for (const item of fields.get(2) ?? []) {
    if (item.wire === 0 && typeof item.value === "bigint") {
      if (item.value > 0xffffffffn) unavailable();
      result.push(Number(item.value));
    } else if (item.wire === 2 && Buffer.isBuffer(item.value)) {
      let value = 0, shift = 0;
      for (const byte of item.value) {
        if (shift > 28 || (shift === 28 && byte > 15)) unavailable();
        value += (byte & 127) * 2 ** shift;
        if (byte & 128) shift += 7;
        else { result.push(value); value = 0; shift = 0; }
      }
      if (shift) unavailable();
    } else unavailable();
  }
  if (new Set(result).size !== result.length) unavailable();
  return result;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return unavailable();
}
function call(fields: Fields) {
  if (fields.has(4) || fields.has(5)) unavailable();
  const id = scalar(fields, 1, 2), name = scalar(fields, 2, 2), encoded = scalar(fields, 3, 2);
  if (!Buffer.isBuffer(id) || !id.length || !Buffer.isBuffer(name) || !Buffer.isBuffer(encoded)) unavailable();
  const args: unknown = JSON.parse(encoded.toString("utf8"));
  if (!args || typeof args !== "object" || Array.isArray(args)) unavailable();
  return { id, name: name.toString("utf8"), args: args as Record<string, unknown> };
}
function total(row: NativeGenerationUsage): number {
  const value = row.input + row.cacheRead + row.output;
  if (!Number.isSafeInteger(value) || row.cacheWrite !== 0) unavailable();
  return value;
}

export function createNativeUsageReader(profile: string, sessionId: string) {
  let identity: { dev: number; ino: number };
  let baseline: { generation: number; step: number } | undefined;
  const consumedCalls = new Set<string>();
  const verifiedContexts = new Map<number, string>();
  const file = join(profile, "conversations", sessionId + ".db");
  const check = () => {
    if (!isAbsolute(profile) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId)) unavailable();
    for (const directory of [profile, join(profile, "conversations")]) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== process.getuid() || realpathSync(directory) !== directory) unavailable();
    }
    const ordinary = (path: string) => {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || realpathSync(path) !== path) unavailable();
      return stat;
    };
    const stat = ordinary(file);
    if (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino)) unavailable();
    identity ??= { dev: stat.dev, ino: stat.ino };
    // Live SQLite may legitimately create, replace or remove its sidecars.
    // Validate every observed sidecar, without pinning their existence/inodes.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { ordinary(file + suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  };
  const transaction = <T>(read: (db: DatabaseSync) => T): T => {
    let db: DatabaseSync | undefined;
    try {
      check(); db = new DatabaseSync(file, { readOnly: true });
      db.exec("PRAGMA busy_timeout=0"); db.exec("BEGIN");
      const rows = db.prepare("SELECT cascade_id FROM trajectory_meta").all();
      check();
      if (rows.length !== 1 || rows[0].cascade_id !== sessionId) unavailable();
      const result = read(db); check(); return result;
    } catch { return unavailable(); }
    finally {
      try { if (db?.isTransaction) db.exec("ROLLBACK"); }
      catch { unavailable(); }
      finally { try { db?.close(); } catch { unavailable(); } }
    }
  };
  try { check(); } catch { unavailable(); }

  function fresh(db: DatabaseSync, withSteps: boolean) {
    if (!baseline) unavailable();
    const generationRows = db.prepare("SELECT idx FROM gen_metadata WHERE idx>? ORDER BY idx").all(baseline.generation);
    const stepRows = withSteps ? db.prepare("SELECT idx FROM steps WHERE idx>? ORDER BY idx").all(baseline.step) : [];
    if (!generationRows.length) unavailable();
    for (const [rows, lower] of [[generationRows, baseline.generation], [stepRows, baseline.step]] as const) {
      let previous = lower;
      for (const row of rows) {
        if (!Number.isSafeInteger(row.idx) || Number(row.idx) <= previous) unavailable();
        previous = Number(row.idx);
      }
    }
    const generations = generationRows.map(row => {
      const stored = db.prepare("SELECT data FROM gen_metadata WHERE idx=?").get(row.idx);
      if (!(stored?.data instanceof Uint8Array)) unavailable();
      const fields = parse(stored.data), usage = child(child(fields, 1), 4);
      const result = { index: Number(row.idx), input: counter(usage, 2), output: counter(usage, 3), cacheRead: counter(usage, 5), cacheWrite: counter(usage, 4) };
      total(result);
      return { usage: result, steps: indices(fields), ...contextEvidence(fields, result,
        result.index < Number(generationRows.at(-1)!.idx) ? verifiedContexts.get(result.index) : undefined) };
    });
    const steps = stepRows.map(row => {
      const stored = db.prepare("SELECT step_type,metadata,step_payload FROM steps WHERE idx=?").get(row.idx);
      if (!(stored?.metadata instanceof Uint8Array) || !(stored.step_payload instanceof Uint8Array)) unavailable();
      return { index: Number(row.idx), type: stored.step_type, metadata: parse(stored.metadata), payload: parse(stored.step_payload) };
    });
    return { generations, steps };
  }
  function snapshot(generations: ReturnType<typeof fresh>["generations"], selected: NativeGenerationUsage): NativeUsageSnapshot {
    const observed = generations.filter(row => row.usage.index <= selected.index);
    const present = new Set(observed.map(row => row.usage.index));
    const integrity: NativeContextIntegrity = observed.find(row => row.context.status === "truncated")?.context
      ?? { status: observed.some(row => row.context.status === "unknown") || [...verifiedContexts.keys()].some(index => !present.has(index))
        ? "unknown" : "intact" };
    return { snapshot: { generationIndex: selected.index, input: selected.input, output: selected.output, cacheRead: selected.cacheRead,
      cacheWrite: selected.cacheWrite, totalTokens: total(selected), generations: observed.map(row => ({ ...row.usage })), contextIntegrity: integrity },
      witnesses: observed.map(row => ({ index: row.usage.index, witness: row.witness, status: row.context.status })) };
  }
  function remember(result: ReturnType<typeof snapshot>): NativeUsageSnapshot {
    // Publish evidence only after transaction rollback and close both succeed.
    for (const { index, witness, status } of result.witnesses) {
      if (witness) verifiedContexts.set(index, witness);
      else if (status !== "intact") verifiedContexts.delete(index);
    }
    return result.snapshot;
  }
  return {
    beginPrompt(): void {
      baseline = undefined;
      consumedCalls.clear();
      verifiedContexts.clear();
      const value = transaction(db => {
        const generation = db.prepare("SELECT MAX(idx) AS idx FROM gen_metadata").get()?.idx ?? -1;
        const step = db.prepare("SELECT MAX(idx) AS idx FROM steps").get()?.idx ?? -1;
        if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(step) || Number(generation) < -1 || Number(step) < -1) unavailable();
        return { generation: Number(generation), step: Number(step) };
      });
      baseline = value;
    },
    readTool(name: string, args: unknown, declaresToolSummary: boolean): NativeUsageSnapshot {
      const result = transaction(db => {
        if (typeof name !== "string" || !name || !args || typeof args !== "object" || Array.isArray(args)
          || (!declaresToolSummary && Object.hasOwn(args, "toolSummary"))) unavailable();
        const expected = canonical(args), { generations, steps } = fresh(db, true);
        const matches = (item: ReturnType<typeof call>) => {
          const values = { ...item.args };
          if (!declaresToolSummary) delete values.toolSummary;
          return item.name === "mcp_pi_" + name && canonical(values) === expected;
        };
        const planners = steps.filter(step => step.type === 15).flatMap(step => {
          if (counter(step.payload, 1) !== 15 || step.metadata.has(29)) unavailable();
          return (child(step.payload, 20).get(7) ?? []).map(item => {
            if (item.wire !== 2 || !Buffer.isBuffer(item.value)) unavailable();
            return { step: step.index, call: call(parse(item.value)) };
          });
        });
        const generic = steps.filter(step => step.type === 132).map(step => {
          if (counter(step.payload, 1) !== 132 || step.metadata.has(29)) unavailable();
          child(step.payload, 140);
          return { step: step.index, call: call(child(step.metadata, 4)) };
        });
        for (const calls of [planners, generic]) {
          if (new Set(calls.map(item => item.call.id.toString("hex"))).size !== calls.length) unavailable();
        }
        const pairs = planners.filter(item => matches(item.call)).flatMap(planner => generic.filter(tool => matches(tool.call) && planner.step < tool.step
          && planner.call.id.equals(tool.call.id) && planner.call.name === tool.call.name
          && canonical(planner.call.args) === canonical(tool.call.args)).map(tool => ({
          planner: planner.step, generic: tool.step, key: planner.call.id.toString("hex"),
        }))).filter(pair => !consumedCalls.has(pair.key));
        if (pairs.length !== 1) unavailable();
        const pair = pairs[0];
        const candidates = generations.filter(row => row.steps.includes(pair.planner) && row.steps.includes(pair.generic));
        if (candidates.length !== 1 || candidates[0] !== generations.at(-1) || total(candidates[0].usage) <= 0) unavailable();
        return { key: pair.key, ...snapshot(generations, candidates[0].usage) };
      });
      // A failed transaction/close must never consume a call. Successful reads
      // allocate one native call to one callback, even before another DB update.
      consumedCalls.add(result.key);
      return remember(result);
    },
    readCompletion(used: number): NativeUsageSnapshot {
      return remember(transaction(db => {
        if (!Number.isSafeInteger(used) || used < 0) unavailable();
        const { generations } = fresh(db, false), candidates = generations.filter(row => total(row.usage) === used);
        // Arithmetic and ordering only; the bridge must additionally require a
        // fresh owned usage_update ordinal. This is not a native generation ID.
        if (candidates.length !== 1 || candidates[0] !== generations.at(-1)) unavailable();
        return snapshot(generations, candidates[0].usage);
      }));
    },
  };
}
