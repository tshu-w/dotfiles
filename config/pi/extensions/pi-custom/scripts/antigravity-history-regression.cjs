// Opt-in local regression. Never include this script in the default test suite.
const { readFileSync, readdirSync, statSync, lstatSync, realpathSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { join, dirname, resolve } = require("node:path");
const { tmpdir, homedir, userInfo } = require("node:os");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual, promisify } = require("node:util");
const { createServer, request: httpRequest } = require("node:http");
const childProcess = require("node:child_process");
const { execFile, execFileSync } = childProcess;
const { syncBuiltinESMExports } = require("node:module");
const runFile = promisify(execFile);

const digest = value => createHash("sha256").update(value).digest("hex");
const VALIDATION_REQUEST = "Local history regression: reply OK without calling any tool.";

// Same malformed-line policy as Pi's parser, without its source-file repair path.
function parseEntries(bytes) {
  return bytes.toString("utf8").split("\n").flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
function visibleBytes(messages) {
  let bytes = 0;
  for (const message of messages) {
    if (typeof message.content === "string") bytes += Buffer.byteLength(message.content);
    else for (const block of message.content ?? []) {
      if (block.type === "text") bytes += Buffer.byteLength(block.text);
      if (block.type === "toolCall") bytes += Buffer.byteLength(JSON.stringify(block.arguments));
    }
  }
  return bytes;
}
function sessionFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sessionFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push({ path, modified: statSync(path).mtimeMs });
  }
  return files;
}
function selectSessions(root, sdk, counts, limit = 30, inspect = false) {
  const selected = [];
  const files = sessionFiles(root).sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
  for (const file of files) {
    counts.scanned++;
    const source = readFileSync(file.path);
    const entries = parseEntries(source);
    if (entries[0]?.type !== "session") { counts.invalid++; continue; }
    const original = JSON.stringify(entries);
    const working = structuredClone(entries);
    sdk.migrateSessionEntries(working);
    const tree = working.filter(entry => entry.type !== "session");
    const leaf = tree.at(-1)?.id ?? null;
    const messages = sdk.convertToLlm(sdk.buildSessionContext(tree, leaf).messages);
    if (JSON.stringify(entries) !== original) throw new Error("source_memory_changed");
    if (visibleBytes(messages) <= 185000) continue;
    let systemProvenance;
    if (inspect) {
      systemProvenance = { messageEntries: 0, compactionSnapshots: 0, otherEntries: 0 };
      for (const entry of sdk.buildSessionProjection(tree, leaf).entries) {
        const count = entry.messages.filter(message => message.role === "system").length;
        const key = entry.sourceEntry.type === "message" ? "messageEntries" : entry.sourceEntry.type === "compaction" ? "compactionSnapshots" : "otherEntries";
        systemProvenance[key] += count;
      }
    }
    selected.push({ path: file.path, sourceHash: digest(source), sourceBytes: source.length, messages: structuredClone(messages), ...(systemProvenance ? { systemProvenance } : {}) });
    if (selected.length === limit) break;
  }
  counts.selected = selected.length;
  return selected;
}
function sourceStatus(sample) {
  const current = readFileSync(sample.path);
  if (current.length < sample.sourceBytes || digest(current.subarray(0, sample.sourceBytes)) !== sample.sourceHash) return { changed: true, appendedBytes: 0 };
  return { changed: false, appendedBytes: current.length - sample.sourceBytes };
}
function requestMessages(messages) {
  const copy = structuredClone(messages);
  if (copy.findLast(message => message.role !== "system")?.role !== "user") copy.push({ role: "user", content: VALIDATION_REQUEST, timestamp: 0 });
  return copy;
}

function projectFailedAssistants(messages) {
  const omitted = { error: 0, aborted: 0 };
  return { omitted, messages: messages.filter(message => {
    if (message.role === "assistant" && ["error", "aborted"].includes(message.stopReason)) { omitted[message.stopReason]++; return false; }
    return true;
  }) };
}

// Build expected ACP blocks from source messages, not production promptContent.
// Historical messages never participate in this single-live-step projection.
function livePromptOracle(messages, boundary) {
  const users = messages.slice(boundary), blocks = [];
  for (const [index, message] of users.entries()) {
    if (message.role !== "user") throw new Error("live_prompt_source");
    if (index) blocks.push({ type: "text", text: "\n\n" });
    if (typeof message.content === "string") blocks.push({ type: "text", text: message.content });
    else for (const block of message.content) {
      if (!(["text", "image"].includes(block.type))) throw new Error("live_prompt_source");
      blocks.push(structuredClone(block));
    }
  }
  const textOnly = blocks.every(block => block.type === "text" && typeof block.text === "string");
  const historical = expectedHistory(messages.slice(0, boundary));
  // Image-bearing source layouts remain exact, without assuming unprobed
  // cross-message image/text reordering. Each image is still compared normally.
  const live = textOnly ? [{ role: "user", parts: [{ kind: "text", text: blocks.map(block => block.text).join("") }] }]
    : expectedHistory(users, 0);
  return { expected: [...historical, ...live], liveExpected: live, blocks, sourceUserCount: users.length,
    coalescing: Number(textOnly && users.length > 1), separatorBytes: Math.max(0, users.length - 1) * 2 };
}

const SYSTEM_ROUTING = "Use only the Pi tools exposed through MCP. Short tool names in the following instructions refer to their mcp_pi_<name> counterparts.";

function validSystemSources(messages) {
  const text = value => typeof value === "string" && value.isWellFormed();
  return messages.filter(message => message.role === "system").every(message =>
    (text(message.content) || (Array.isArray(message.content) && message.content.every(block => block?.type === "text" && text(block.text))))
    && (message.sections === undefined || (message.sections !== null && typeof message.sections === "object" && !Array.isArray(message.sections)
      && Object.values(message.sections).every(value => value === null || text(value)))));
}

// Independent approved policy: omit only shape-matching named default sections.
function defaultSystemSection(name, text) {
  if (name === "preamble") return /^You are [^\n]* inside pi, a coding agent harness\. (?:You help|Help) users [^.\n]*\.$/.test(text);
  if (name === "docs") return /^<docs>\nPi documentation \([^\n]*\):\n(?:- [^\n]*\n)+<\/docs>$/.test(text);
  return false;
}

// Verify the original snapshot before projecting approved default omissions and
// tool references, then check the exact append and its native placement.
function compareSystem(system, sourcePrompt, toolNames, append, body) {
  const fail = kind => ({ differences: [kind], toolReferenceMappings: 0, verified: 0 });
  const content = system ? typeof system.content === "string" ? system.content
    : system.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
  const sourceParts = [{ text: content, rename: false }, ...Object.entries(system?.sections ?? {}).filter(([, text]) => text !== null)
    .map(([name, text]) => ({ name, text, rename: ["tools", "rules", "skills"].includes(name) }))].filter(part => part.text.length > 0);
  if (sourceParts.map(part => part.text).join("\n\n") !== sourcePrompt) return fail("system_source_shape");
  const parts = sourceParts.filter(part => !defaultSystemSection(part.name, part.text));
  const routing = toolNames.length ? SYSTEM_ROUTING : "No Pi tools are available for this request.";
  const prefix = routing + (parts.length ? "\n\n" : "");
  if (typeof append !== "string" || !append.startsWith(prefix)) return fail("system_routing");
  const target = append.slice(prefix.length), names = [...toolNames].sort((a, b) => b.length - a.length);
  let position = 0, mappings = 0;
  const reference = (text, index, name) => {
    const before = text.slice(0, index), after = text.slice(index + name.length), boundary = !/[\w./-]$/.test(before);
    return (/(?:^|\n)- $/.test(before) && after.startsWith(":"))
      || (before.endsWith("`") && after.startsWith("`"))
      || (boundary && after.startsWith("("))
      || (/\bUse (?:the )?$/.test(before) && !/^[\w./-]/.test(after))
      || (boundary && /^ tool\b/.test(after));
  };
  for (const [partIndex, part] of parts.entries()) {
    if (partIndex) { if (target.slice(position, position + 2) !== "\n\n") return fail("system_prompt"); position += 2; }
    for (let index = 0; index < part.text.length; index++) {
      if (part.rename && names.some(name => part.text.startsWith(name, index) && target.startsWith("mcp_pi_" + name, position) && reference(part.text, index, name))) {
        position += 7; mappings++;
      }
      if (part.text[index] !== target[position++]) return fail("system_prompt");
    }
  }
  if (position !== target.length) return fail("system_prompt");
  const nativeParts = body?.systemInstruction?.parts;
  if (!Array.isArray(nativeParts) || nativeParts.length !== 1 || typeof nativeParts[0].text !== "string" || Object.keys(nativeParts[0]).length !== 1) return fail("system_instruction_shape");
  const native = nativeParts[0].text;
  if (!native.endsWith(append)) return fail("system_native_append");
  if (!native.slice(0, native.length - append.length).endsWith("\n</communication_style>\n")) return fail("system_native_frame");
  return { differences: [], toolReferenceMappings: mappings, verified: 1 };
}

function omittableEmptyAssistant(message) {
  if (message.role !== "assistant" || message.stopReason !== "stop" || message.deferred !== undefined
    || message.errorMessage !== undefined || !Array.isArray(message.content)) return false;
  const visible = message.content.filter(block => block?.type !== "thinking");
  return visible.length === 1 && visible[0]?.type === "text" && visible[0].text === "";
}

// The oracle originates in Pi messages, not prepareHistory or the SQLite writer.
// Source indices remain intact; only validated zero-text assistant targets vanish.
function expectedHistory(messages, historyBoundary = messages.length) {
  const history = messages.flatMap((message, messageIndex) => {
    if (omittableEmptyAssistant(message)) return [];
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const parts = blocks.filter(block => block.type !== "thinking").map(block => {
      if (block.type === "text") return { kind: "text", text: block.text };
      if (block.type === "toolCall") return { kind: "call", id: block.id, name: block.name, args: structuredClone(block.arguments) };
      if (block.type === "image") return message.role === "toolResult"
        ? { kind: "text", text: "[Pi omitted an image]" }
        : { kind: "image", mimeType: block.mimeType, data: block.data };
      throw new Error("unsupported_source_part");
    });
    if (!parts.length && message.role === "assistant") return [];
    if (message.role === "toolResult") {
      return [{ role: "toolResult", id: message.toolCallId, name: message.toolName, isError: message.isError === true,
        textBudget: message.isError ? 48 * 1024 - 37 : 48 * 1024, parts: [{ kind: "text", text: parts.map(part => part.text).join("\n") }] }];
    }
    return [{ role: message.role, parts,
      ...(messageIndex < historyBoundary && message.role === "user" ? { textBudget: 185000 } : {}) }];
  });
  // Only a complete adjacent result set may be placed in its own call-batch
  // order. Missing/duplicate/foreign IDs cannot be hidden by this normalization.
  for (let index = 0; index < history.length; index++) {
    const calls = history[index].role === "assistant" ? history[index].parts.filter(part => part.kind === "call") : [];
    if (calls.length < 2) continue;
    const results = history.slice(index + 1, index + 1 + calls.length);
    const byId = new Map(results.map(result => [result.id, result]));
    if (results.length === calls.length && byId.size === calls.length
      && new Set(calls.map(call => call.id)).size === calls.length && results.every(result => result.role === "toolResult")
      && calls.every(call => byId.get(call.id)?.name === call.name)) {
      history.splice(index + 1, calls.length, ...calls.map(call => byId.get(call.id)));
    }
  }
  return history;
}

// Exact source-derived target, independently of the writer. No additional
// shortening is accepted, even if it would still satisfy balanced-end bounds.
function approvedText(source, actual, budget) {
  const target = projectedText(source, budget);
  return target === actual ? (target === source ? "exact" : "approved_truncation") : false;
}

function projectedText(source, budget) {
  let target = source;
  const total = Buffer.byteLength(source);
  if (budget && total > budget) {
    // Independent code-point implementation of the approved target policy:
    // reserve digits using the original byte count, then split floor/ceil.
    const marker = omitted => `\n\n[Pi omitted ${omitted} ${omitted === 1 ? "byte" : "bytes"}]\n\n`;
    const available = budget - Buffer.byteLength(marker(total));
    const points = [...source], head = [], tail = [];
    let headBytes = 0, tailBytes = 0;
    for (const point of points) {
      const size = Buffer.byteLength(point);
      if (headBytes + size > Math.floor(available / 2)) break;
      head.push(point); headBytes += size;
    }
    for (let index = points.length - 1; index >= 0; index--) {
      const size = Buffer.byteLength(points[index]);
      if (tailBytes + size > Math.ceil(available / 2)) break;
      tail.push(points[index]); tailBytes += size;
    }
    target = head.join("") + marker(total - headBytes - tailBytes) + tail.reverse().join("");
  }
  return target;
}

function historyWindowOracle(messages, promptTextBytes, maxBytes = 500000) {
  const admission = admissionReason(messages);
  const unchanged = { expected: [], omittedMessages: 0, omittedTargetBytes: 0, markerNetBytes: 0,
    intraOmittedMessages: 0, intraOmittedTargetBytes: 0, intraMarkerNetBytes: 0, omittedEmptyAssistants: 0,
    promptTextBytes, promptExceeded: promptTextBytes > 185000, budgetExceeded: false,
    losses: { userTruncated: 0, toolResultsTruncated: 0, earlierMessagesOmitted: 0, intermediateMessagesOmitted: 0, toolImagesOmitted: 0 } };
  if (!messages.length) return { ...unchanged, targetBytes: 0 };
  if (admission !== "unclassified_admission") return { ...unchanged, rejectedAdmission: admission };
  const cost = history => history.reduce((total, message) => total + message.parts.reduce((sum, part) => sum
    + (part.kind === "text" ? Buffer.byteLength(projectedText(part.text, message.textBudget))
      : part.kind === "call" ? Buffer.byteLength(JSON.stringify(part.args)) : 0), 0), 0);
  const losses = (retained, earlierMessagesOmitted = 0, intermediateMessagesOmitted = 0) => {
    const counts = { userTruncated: 0, toolResultsTruncated: 0, earlierMessagesOmitted, intermediateMessagesOmitted, toolImagesOmitted: 0 };
    for (const message of retained) {
      if (message.role !== "user" && message.role !== "toolResult") continue;
      const target = expectedHistory([message])[0];
      const truncated = target.parts.some(part => part.kind === "text" && projectedText(part.text, target.textBudget) !== part.text);
      if (message.role === "user") counts.userTruncated += Number(truncated);
      else {
        counts.toolResultsTruncated += Number(truncated);
        counts.toolImagesOmitted += message.content.filter(block => block.type === "image").length;
      }
    }
    return counts;
  };
  unchanged.expected = expectedHistory(messages);
  if (!unchanged.expected.length) return { ...unchanged, rejectedAdmission: "empty_projected_history" };
  const costs = messages.map(message => cost(expectedHistory([message]))), prefix = [0];
  for (const bytes of costs) prefix.push(prefix.at(-1) + bytes);
  const total = prefix.at(-1);
  if (unchanged.promptExceeded) return { ...unchanged, targetBytes: total };
  if (total + promptTextBytes <= maxBytes) return { ...unchanged, targetBytes: total,
    omittedEmptyAssistants: messages.filter(omittableEmptyAssistant).length, losses: losses(messages) };
  const marked = (message, head, tail) => {
    const copy = structuredClone(message);
    if (typeof copy.content === "string") copy.content = head + copy.content + tail;
    else copy.content[0].text = head + copy.content[0].text + tail;
    return copy;
  };
  const head = start => start ? `[Pi omitted ${start} earlier ${start === 1 ? "message" : "messages"}]\n\n` : "";
  const starts = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === "user" && (index === 0 || messages[index - 1].role !== "user")) starts.push(index);
  }
  // Complete rounds always take precedence over intra-round omission.
  for (const start of starts) {
    if (!start) continue;
    const first = marked(messages[start], head(start), "");
    const expected = expectedHistory([first, ...messages.slice(start + 1)]);
    const markerNetBytes = cost(expectedHistory([first])) - costs[start], targetBytes = cost(expected);
    if (targetBytes + promptTextBytes > maxBytes) continue;
    return { ...unchanged, expected, omittedMessages: start, omittedTargetBytes: prefix[start], markerNetBytes, targetBytes,
      omittedEmptyAssistants: messages.slice(start).filter(omittableEmptyAssistant).length,
      losses: losses([first, ...messages.slice(start + 1)], start) };
  }
  const start = starts.at(-1);
  if (start !== undefined) {
    let userEnd = start;
    while (userEnd < messages.length && messages[userEnd].role === "user") userEnd++;
    const groups = [];
    for (let index = userEnd; index < messages.length; index++) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      const calls = message.content.filter(block => block.type === "toolCall");
      if (calls.length || message.content.some(block => block.type === "text" && block.text.length)) groups.push(index);
      index += calls.length;
    }
    const users = messages.slice(start, userEnd);
    const headUsers = users.map((message, index) => marked(message, index === 0 ? head(start) : "", ""));
    const headUserCost = cost(expectedHistory(headUsers));
    const markerNetBytes = headUserCost - (prefix[userEnd] - prefix[start]);
    // Discard at least one visible group, retaining the last and its hidden tail.
    for (let group = 1; group < groups.length; group++) {
      const retainedStart = groups[group], intraOmittedMessages = retainedStart - userEnd;
      const tail = `\n\n[Pi omitted ${intraOmittedMessages} intermediate ${intraOmittedMessages === 1 ? "message" : "messages"}]\n\n`;
      const finalUsers = users.map((message, index) => marked(message,
        index === 0 ? head(start) : "", index === users.length - 1 ? tail : ""));
      const expected = expectedHistory([...finalUsers, ...messages.slice(retainedStart)]), targetBytes = cost(expected);
      if (targetBytes + promptTextBytes > maxBytes) continue;
      return { ...unchanged, expected, omittedMessages: start, omittedTargetBytes: prefix[start], markerNetBytes,
        intraOmittedMessages, intraOmittedTargetBytes: prefix[retainedStart] - prefix[userEnd],
        intraMarkerNetBytes: cost(expectedHistory(finalUsers)) - headUserCost, targetBytes,
        omittedEmptyAssistants: messages.slice(retainedStart).filter(omittableEmptyAssistant).length,
        losses: losses([...finalUsers, ...messages.slice(retainedStart)], start, intraOmittedMessages) };
    }
  }
  return { ...unchanged, targetBytes: total, budgetExceeded: true };
}

function approvedUserText(source, actual, budget) {
  if (!source.isWellFormed()) return false;
  const direct = approvedText(source, actual, budget);
  if (direct) return { kind: direct, characters: 0, bytes: 0 };
  const target = projectedText(source, budget);
  const cleaned = target.replace(/[\uE000\uF8FE\uF8FF\u200C\u200D\u200E]/gu, "");
  if (cleaned === target || cleaned !== actual) return false;
  return { kind: target === source ? "exact" : "approved_truncation", characters: target.length - cleaned.length,
    bytes: Buffer.byteLength(target) - Buffer.byteLength(cleaned) };
}

function compareHistory(expected, actual) {
  const differences = new Set(), ids = new Map(), usedIds = new Set(), knownDifferences = {};
  let truncations = 0;
  if (expected.length !== actual.length) differences.add("message_count");
  for (let index = 0; index < Math.min(expected.length, actual.length); index++) {
    const a = expected[index], b = actual[index];
    if (a.role !== b.role) differences.add("role_order");
    if (a.role === "toolResult") {
      if (ids.get(a.id) !== b.id || a.name !== b.name) differences.add("result_identity");
      if (a.isError !== b.isError) differences.add("result_error_status");
    }
    if (a.parts.length !== b.parts.length) differences.add("part_count");
    for (let j = 0; j < Math.min(a.parts.length, b.parts.length); j++) {
      const x = a.parts[j], y = b.parts[j];
      if (x.kind !== y.kind) { differences.add("part_order"); continue; }
      if (x.kind === "text") {
        const match = a.role === "user" && b.role === "user" ? approvedUserText(x.text, y.text, a.textBudget)
          : { kind: approvedText(x.text, y.text, a.textBudget), characters: 0, bytes: 0 };
        if (!match?.kind) differences.add("text");
        if (match?.kind === "approved_truncation") truncations++;
        if (match?.characters) {
          const known = knownDifferences.native_user_unicode_removal ??= { texts: 0, characters: 0, bytes: 0 };
          known.texts++; known.characters += match.characters; known.bytes += match.bytes;
        }
      } else if (x.kind === "call") {
        if (!y.id || usedIds.has(y.id) || ids.has(x.id)) differences.add("call_identity");
        ids.set(x.id, y.id); usedIds.add(y.id);
        if (x.name !== y.name) differences.add("tool_name");
        if (!isDeepStrictEqual(x.args, y.args)) differences.add("tool_arguments");
      } else if (!isDeepStrictEqual(x, y)) differences.add("image");
    }
  }
  return { differences: [...differences], truncations, knownDifferences };
}

// Only fixed enums, ordinals, counts, lengths, and booleans leave this helper.
// Ordinals are zero-based. Empty assistants contain only exactly empty text.
function anonymousComparison(expected, actual, body, framing) {
  if (!compareHistory(expected, actual).differences.length) return null;
  const role = value => ["user", "assistant", "toolResult"].includes(value) ? value : "unknown";
  const kinds = () => ({ text: 0, call: 0, image: 0, result: 0, unknown: 0 });
  const describe = message => {
    if (!message) return { role: "missing" };
    const partKinds = kinds();
    let textBytes = 0, argsBytes = 0;
    for (const part of message.parts) {
      const kind = ["text", "call", "image"].includes(part.kind) ? part.kind : "unknown";
      partKinds[kind]++;
      if (kind === "text") textBytes += Buffer.byteLength(projectedText(part.text, message.textBudget));
      if (kind === "call") {
        const encoded = JSON.stringify(part.args);
        argsBytes = encoded === undefined || argsBytes === null ? null : argsBytes + Buffer.byteLength(encoded);
      }
    }
    return { role: role(message.role), partKinds, textBytes, argsBytes,
      isError: typeof message.isError === "boolean" ? message.isError : "missing" };
  };
  const emptyAssistants = history => history.filter(message => message.role === "assistant"
    && message.parts.every(part => part.kind === "text" && part.text === "")).length;
  let low = 1, high = Math.max(expected.length, actual.length);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareHistory(expected.slice(0, middle), actual.slice(0, middle)).differences.length) high = middle;
    else low = middle + 1;
  }
  const firstOrdinal = low - 1;
  const http = [], notices = new Set(framing?.notices ?? []);
  for (const [contentOrdinal, content] of body.contents.entries()) {
    if (content.role === "user" && content.parts.length === 1 && notices.delete(content.parts[0].text)) continue;
    const partKinds = kinds();
    for (const part of content.parts) {
      const kind = part.functionResponse ? "result" : typeof part.text === "string" ? "text"
        : part.functionCall ? "call" : part.inlineData ? "image" : "unknown";
      partKinds[kind]++;
    }
    const description = { contentOrdinal,
      role: ["user", "model"].includes(content.role) ? content.role : "unknown", partKinds };
    const count = partKinds.result || 1;
    for (let index = 0; index < count; index++) http.push(description);
  }
  const neighborhood = [];
  for (let ordinal = Math.max(0, firstOrdinal - 1);
    ordinal <= Math.min(Math.max(expected.length, actual.length) - 1, firstOrdinal + 1); ordinal++) {
    neighborhood.push({ ordinal, source: describe(expected[ordinal]), actual: describe(actual[ordinal]),
      http: actual[ordinal] && http[ordinal] ? http[ordinal] : { role: "missing" } });
  }
  return { expectedLength: expected.length, actualLength: actual.length,
    expectedEmptyAssistants: emptyAssistants(expected), actualEmptyAssistants: emptyAssistants(actual),
    firstOrdinal, neighborhood };
}

function anonymousComparisonSelfTest() {
  const assert = require("node:assert/strict");
  let checks = 0;
  const same = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
  const secret = "PRIVATE_SENTINEL_4c290";
  const text = value => ({ kind: "text", text: value });
  const user = value => ({ role: "user", parts: [text(value)] });
  const empty = { role: "assistant", parts: [text("")] };
  const call = { kind: "call", id: secret, name: secret, args: { value: secret } };
  const assistant = { role: "assistant", parts: [text(secret), call] };
  const result = { role: "toolResult", id: secret, name: secret, isError: false, parts: [text(secret)] };
  const expected = [user(secret), empty, assistant, result];
  const actual = [user(secret), assistant, result];
  const body = { contents: [
    { role: "user", parts: [{ text: secret }] },
    { role: "model", parts: [{ text: secret }, { functionCall: { id: secret, name: secret, args: { value: secret } } }] },
    { role: "model", parts: [{ functionResponse: { id: secret, name: secret, response: { output: secret } } }] },
  ] };
  const before = structuredClone({ expected, actual, body });
  const diagnostic = anonymousComparison(expected, actual, body);
  same(diagnostic.firstOrdinal, 1);
  same(diagnostic.expectedLength, 4);
  same(diagnostic.actualLength, 3);
  same(diagnostic.expectedEmptyAssistants, 1);
  same(diagnostic.actualEmptyAssistants, 0);
  same(diagnostic.neighborhood.map(item => item.ordinal), [0, 1, 2]);
  same(diagnostic.neighborhood[1].actual.argsBytes, Buffer.byteLength(JSON.stringify(call.args)));
  same(diagnostic.neighborhood[1].http.contentOrdinal, 1);
  same(diagnostic.neighborhood[2].http.partKinds.result, 1);
  const serialized = JSON.stringify(diagnostic);
  same(serialized.includes(secret), false);
  same(serialized.includes(digest(secret)), false);
  same(/hash|[a-f0-9]{64}/i.test(serialized), false);
  same({ expected, actual, body }, before);
  same(anonymousComparison(expected, structuredClone(expected), body), null);
  same(anonymousComparison([user("A\uE000B")], [user("AB")], body), null);
  const missingArgs = anonymousComparison([assistant], [{ role: "assistant", parts: [{ ...call, args: undefined }] }], body);
  same(missingArgs.neighborhood[0].actual.argsBytes, null);
  same(JSON.stringify(missingArgs).includes(secret), false);

  const missing = anonymousComparison(expected, expected.slice(0, -1), body);
  same(missing.firstOrdinal, 3);
  same(missing.neighborhood.at(-1).actual.role, "missing");
  same(missing.neighborhood.at(-1).http.role, "missing");
  const changed = anonymousComparison([user(secret)], [{ role: "assistant", parts: [text(secret)] }], body);
  same(changed.firstOrdinal, 0);
  same(changed.neighborhood[0].actual.role, "assistant");

  // One HTTP response batch produces multiple canonical result messages.
  const batchBody = { contents: [body.contents[0], body.contents[1],
    { role: "model", parts: [...body.contents[2].parts, ...body.contents[2].parts] },
    { role: "user", parts: [{ text: secret + "notice" }] }] };
  const decoded = decodeRequest({ contents: batchBody.contents.slice(0, -1) });
  const batched = anonymousComparison(decoded.slice(0, -1), decoded, batchBody, { notices: [secret + "notice"] });
  same(batched.firstOrdinal, 3);
  same(batched.neighborhood.map(item => item.http.contentOrdinal), [2, 2]);
  same(batched.neighborhood.map(item => item.http.partKinds.result), [2, 2]);
  same(batched.neighborhood.at(-1).source.role, "missing");
  same(JSON.stringify(batched).includes(secret), false);

  // Unknown roles and kinds are never reflected as dynamic strings or keys.
  const unknown = anonymousComparison([user(secret)], [{ role: secret, parts: [{ kind: secret }] }],
    { contents: [{ role: secret, parts: [{ [secret]: secret }] }] });
  same(unknown.neighborhood[0].actual.role, "unknown");
  same(unknown.neighborhood[0].actual.partKinds.unknown, 1);
  same(unknown.neighborhood[0].http.role, "unknown");
  same(unknown.neighborhood[0].http.partKinds.unknown, 1);
  same(JSON.stringify(unknown).includes(secret), false);
  return checks;
}

function diagnoseComparison(expected, actual) {
  const locations = [];
  for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
    const source = expected[index], target = actual[index];
    const sourceParts = source?.parts ?? [], targetParts = target?.parts ?? [];
    if (!source || !target || source.role !== target.role || sourceParts.length !== targetParts.length) {
      locations.push({ messageIndex: index, sourceRole: source?.role ?? "missing", actualRole: target?.role ?? "missing",
        sourceParts: sourceParts.length, actualParts: targetParts.length });
    }
    for (let part = 0; part < Math.max(sourceParts.length, targetParts.length); part++) {
      const a = sourceParts[part], b = targetParts[part];
      if (a?.kind !== "text" && b?.kind !== "text") continue;
      const sourceBytes = a?.kind === "text" ? Buffer.from(a.text) : undefined;
      const actualBytes = b?.kind === "text" ? Buffer.from(b.text) : undefined;
      if (sourceBytes && actualBytes && (source.role === "user" && target.role === "user"
        ? approvedUserText(a.text, b.text, source.textBudget) : approvedText(a.text, b.text, source.textBudget))) continue;
      let offset = 0;
      if (sourceBytes && actualBytes) while (offset < Math.min(sourceBytes.length, actualBytes.length) && sourceBytes[offset] === actualBytes[offset]) offset++;
      locations.push({ messageIndex: index, partIndex: part, sourceRole: source?.role ?? "missing", actualRole: target?.role ?? "missing",
        sourceBytes: sourceBytes?.length ?? null, actualBytes: actualBytes?.length ?? null,
        sourceHash: sourceBytes ? digest(sourceBytes) : null, actualHash: actualBytes ? digest(actualBytes) : null,
        firstDifferenceByte: sourceBytes && actualBytes ? offset : null });
    }
  }
  return locations;
}

function selfTest() {
  const assert = require("node:assert/strict");
  const text = text => ({ type: "text", text });
  const source = [
    { role: "user", content: "question" },
    { role: "assistant", content: [{ type: "toolCall", id: "source", name: "fixture", arguments: { n: 1 } }] },
    { role: "toolResult", toolCallId: "source", toolName: "fixture", content: [text("receipt")] },
  ];
  const expected = expectedHistory(source), actual = structuredClone(expected);
  actual[1].parts[0].id = actual[2].id = "native";
  assert.deepEqual(compareHistory(expected, actual).differences, []);
  actual[2].id = "wrong";
  assert.deepEqual(compareHistory(expected, actual).differences, ["result_identity"]);
  actual[2].id = "native";
  actual[1].parts[0].args.n = 2;
  assert.deepEqual(compareHistory(expected, actual).differences, ["tool_arguments"]);
  assert.equal(visibleBytes([{ role: "user", content: "中" }]), 3);
  assert.equal(visibleBytes([{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] }]), 0);
  assert.equal(requestMessages(source).length, 4);
  assert.equal(source.length, 3);
  assert.equal(parseEntries(Buffer.from('{"type":"session"}\nmalformed\n')).length, 1);
  const long = "a".repeat(60000);
  // Independently worked 48-KiB fixture: 49,124 retained + 28 marker bytes.
  const shortened = "a".repeat(24562) + "\n\n[Pi omitted 10876 bytes]\n\n" + "a".repeat(24562);
  assert.equal(approvedText(long, shortened, 48 * 1024), "approved_truncation");
  assert.equal(approvedText(long, shortened, undefined), false);
  assert.equal(approvedText(long, shortened.replace("10876", "10878"), 48 * 1024), false);
  assert.equal(approvedText(long, "a\n\n[59998 bytes omitted]\n\na", 48 * 1024), false);
  const pending = { ...source[1], stopReason: "toolUse" };
  assert.equal(admissionReason([{ ...pending, errorMessage: "synthetic" }]), "unsupported_assistant_metadata");
  assert.equal(admissionReason([pending]), "incomplete_tool_batch");
  assert.equal(admissionReason([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "" }] }]), "unsupported_user_layout");
  assert.equal(admissionReason([pending, source[2]]), "invalid_result_error_flag");
  assert.equal(requestMessages([{ role: "user", content: "pending" }, { role: "system", content: "", sections: { rules: "updated" } }]).length, 2);
  const system = { content: "BASE", sections: { tools: "- fixture: tool", rules: "Use fixture tool.", unknown: "KEEP `fixture`" } };
  const systemText = "BASE\n\n- fixture: tool\n\nUse fixture tool.\n\nKEEP `fixture`";
  const append = SYSTEM_ROUTING + "\n\nBASE\n\n- mcp_pi_fixture: tool\n\nUse mcp_pi_fixture tool.\n\nKEEP `fixture`";
  const body = { systemInstruction: { parts: [{ text: "NATIVE\n</communication_style>\n" + append }] } };
  const systemResult = compareSystem(system, systemText, ["fixture"], append, body);
  assert.deepEqual(systemResult.differences, []);
  assert.equal(systemResult.toolReferenceMappings, 2);
  assert.deepEqual(compareSystem(system, systemText, ["fixture"], append.replace("KEEP", "DROP"), body).differences, ["system_prompt"]);
  assert.deepEqual(compareSystem(system, systemText, ["fixture"], append, { systemInstruction: { parts: [{ text: "changed" }] } }).differences, ["system_native_append"]);
  assert.deepEqual(compareSystem(system, systemText, ["fixture"], append, { systemInstruction: { parts: [{ text: append }, { text: "extra" }] } }).differences, ["system_instruction_shape"]);
  assert.deepEqual(compareSystem(system, systemText, ["fixture"], append.replace("KEEP `fixture`", "KEEP `mcp_pi_fixture`"), body).differences, ["system_prompt"]);
  assert.deepEqual(compareSystem(system, systemText, ["fixture"], append, { systemInstruction: { parts: [{ text: "unknown wrapper" + append }] } }).differences, ["system_native_frame"]);
  assert.equal(validSystemSources([{ role: "system", ...system }]), true);
  assert.equal(validSystemSources([{ role: "system", content: [text("keep"), { type: "future", value: "unknown" }] }]), false);
  assert.equal(validSystemSources([{ role: "system", content: "keep", sections: { future: { value: "unknown" } } }]), false);
  const preamble = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files.";
  const docs = "<docs>\nPi documentation (read when needed):\n- Main: /synthetic/README.md\n</docs>";
  let systemDefaultChecks = 0;
  for (const [snapshot, retained, names] of [
    [{ content: "BASE", sections: { preamble, docs, rules: "Use fixture tool." } }, "BASE\n\nUse mcp_pi_fixture tool.", ["fixture"]],
    [{ content: "", sections: { preamble, docs } }, "", []],
    [{ content: "", sections: { preamble: preamble.replace("Help users", "You help users"), docs: null } }, "", []],
    [{ content: "", sections: { preamble: preamble + "\nKeep this identity.", docs: docs + "\nKeep this guide." } }, preamble + "\nKeep this identity.\n\n" + docs + "\nKeep this guide.", []],
    [{ content: "", sections: { preamble, docs: "Custom guide" } }, "Custom guide", []],
    [{ content: "", sections: { docs: docs.replace("</docs>", "- Custom same-shape item\n</docs>") } }, "", []],
    [{ content: preamble + "\n\n" + docs }, preamble + "\n\n" + docs, []],
    [{ content: "", sections: { unknown: preamble, docs: "<docs>\nPi documentation (read when needed):\n</docs>" } }, preamble + "\n\n<docs>\nPi documentation (read when needed):\n</docs>", []],
  ]) {
    const original = structuredClone(snapshot);
    const sourceText = [snapshot.content, ...Object.values(snapshot.sections ?? {})].filter(value => value).join("\n\n");
    const routing = names.length ? SYSTEM_ROUTING : "No Pi tools are available for this request.";
    const expectedAppend = routing + (retained ? "\n\n" + retained : "");
    const native = { systemInstruction: { parts: [{ text: "NATIVE\n</communication_style>\n" + expectedAppend }] } };
    assert.deepEqual(compareSystem(snapshot, sourceText, names, expectedAppend, native).differences, []);
    assert.deepEqual(compareSystem(snapshot, sourceText + "changed", names, expectedAppend, native).differences, ["system_source_shape"]);
    assert.deepEqual(snapshot, original);
    systemDefaultChecks += 3;
    if (sourceText !== retained) {
      assert.deepEqual(compareSystem(snapshot, sourceText, names, routing + "\n\n" + sourceText, native).differences, ["system_prompt"]);
      systemDefaultChecks++;
    }
  }
  const unicode = "A\uE000B\uF8FEC\uF8FF\uF8FFD\u200CE\u200DF\u200EG";
  const unicodeExpected = expectedHistory([{ role: "user", content: unicode }]), unicodeActual = structuredClone(unicodeExpected);
  unicodeActual[0].parts[0].text = "ABCDEFG";
  const unicodeResult = compareHistory(unicodeExpected, unicodeActual);
  assert.deepEqual(unicodeResult.differences, []);
  assert.deepEqual(unicodeResult.knownDifferences, { native_user_unicode_removal: { texts: 1, characters: 7, bytes: 21 } });
  assert.deepEqual(compareHistory(unicodeExpected, unicodeExpected).knownDifferences, {});
  assert.equal(approvedUserText(unicode, unicode.replace("\uF8FF", "")), false);
  assert.equal(approvedUserText(unicode + "\u200B", "ABCDEFG"), false);
  assert.equal(approvedUserText(unicode, "ABCDEFG!"), false);
  const assistantUnicode = expectedHistory([{ role: "assistant", content: [text(unicode)] }]), assistantClean = structuredClone(assistantUnicode);
  assistantClean[0].parts[0].text = "ABCDEFG";
  assert.equal(compareHistory(assistantUnicode, assistantClean).differences.includes("text"), true);
  const resultUnicode = expectedHistory([{ role: "toolResult", toolCallId: "unicode", toolName: "fixture", isError: false, content: [text(unicode)] }]), resultClean = structuredClone(resultUnicode);
  resultClean[0].parts[0].text = "ABCDEFG";
  assert.equal(compareHistory(resultUnicode, resultClean).differences.includes("text"), true);
  const cropSource = "H\uF8FF" + "a".repeat(96) + "T\u200D";
  const cropClean = "H" + "a".repeat(23) + "\n\n[Pi omitted 50 bytes]\n\n" + "a".repeat(23) + "T";
  assert.deepEqual(approvedUserText(cropSource, cropClean, 80), { kind: "approved_truncation", characters: 2, bytes: 6 });
  assert.equal(approvedUserText(cropSource, "H" + "a".repeat(28) + "\n\n[40 bytes omitted]\n\n" + "a".repeat(28) + "T", 80), false);
  assert.equal(approvedUserText(cropSource, cropClean.replace("50", "41"), 80), false);
  assert.equal(approvedUserText(cropSource, "H" + "a".repeat(96) + "T", 80), false);
  const wrongRole = structuredClone(unicodeActual); wrongRole[0].role = "assistant";
  assert.deepEqual(compareHistory(unicodeExpected, wrongRole).differences, ["role_order", "text"]);
  assert.deepEqual(compareHistory(unicodeExpected, wrongRole).knownDifferences, {});
  const liveSource = [{ role: "user", content: "H1" }, { role: "user", content: "H2" },
    { role: "assistant", content: [text("history")] }, { role: "user", content: [text("A"), text("B")] }, { role: "user", content: "C" }];
  const liveBefore = structuredClone(liveSource), live = livePromptOracle(liveSource, 3);
  assert.deepEqual(liveSource, liveBefore);
  assert.deepEqual(live.blocks, [text("A"), text("B"), text("\n\n"), text("C")]);
  assert.deepEqual(live.expected.slice(0, 3), expectedHistory(liveSource.slice(0, 3)));
  assert.equal(live.sourceUserCount, 2);
  assert.equal(live.expected.at(-1).parts[0].text, "AB\n\nC");
  assert.equal(live.separatorBytes, 2);
  assert.equal(live.coalescing, 1);
  const oldLive = structuredClone(live.expected); oldLive.at(-1).parts[0].text = "ABC";
  assert.equal(compareHistory(live.expected, oldLive).differences.includes("text"), true);
  assert.equal(isDeepStrictEqual(live.blocks, [text("A"), text("\n\n"), text("C")]), false);
  const imageLive = livePromptOracle([{ role: "user", content: [text("caption"), { type: "image", mimeType: "image/png", data: "AA==" }] }], 0);
  assert.deepEqual(imageLive.expected[0].parts, [{ kind: "text", text: "caption" }, { kind: "image", mimeType: "image/png", data: "AA==" }]);
  const changedImage = structuredClone(imageLive.expected); changedImage[0].parts[1].data = "BB==";
  assert.deepEqual(compareHistory(imageLive.expected, changedImage).differences, ["image"]);
  const failedSource = [{ role: "system", content: "system" }, source[0],
    { ...pending, stopReason: "error", errorMessage: "synthetic", content: [{ ...pending.content[0], id: "failed" }] },
    { role: "assistant", stopReason: "aborted", content: [text("partial")] }, pending,
    { ...source[2], isError: true }, { role: "user", content: "next" }];
  const failedBefore = structuredClone(failedSource), projected = projectFailedAssistants(failedSource);
  assert.deepEqual(projected.omitted, { error: 1, aborted: 1 });
  assert.deepEqual(projected.messages.map(message => message.role), ["system", "user", "assistant", "toolResult", "user"]);
  assert.deepEqual(failedSource, failedBefore);
  assert.equal(projected.messages[3].isError, true);
  assert.equal(admissionReason(projected.messages.slice(1, -1)), "unclassified_admission");
  assert.equal(admissionReason(projectFailedAssistants([pending]).messages), "incomplete_tool_batch");
  assert.equal(admissionReason(projectFailedAssistants([failedSource[2], { ...source[2], isError: false }]).messages), "orphan_result_or_unsupported_role");
  assert.equal(admissionReason([pending, source[0], { ...source[2], isError: false }]), "interleaved_tool_batch");
  const mutableSource = structuredClone(source), stableExpected = expectedHistory(mutableSource);
  mutableSource[1].content[0].arguments.n = 99;
  assert.equal(stableExpected[1].parts[0].args.n, 1);
  const turns = [{ role: "user", content: "old" }, { role: "assistant", content: [text("x".repeat(80))], stopReason: "stop" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }], stopReason: "stop" },
    { role: "user", content: "new" }, { role: "assistant", content: [text("kept")], stopReason: "stop" }];
  const turnsBefore = structuredClone(turns), window = historyWindowOracle(turns, 5, 70);
  assert.equal(window.omittedMessages, 3);
  assert.equal(window.omittedTargetBytes, 83);
  assert.equal(window.expected[0].parts[0].text, "[Pi omitted 3 earlier messages]\n\nnew");
  assert.equal(window.markerNetBytes, Buffer.byteLength("[Pi omitted 3 earlier messages]\n\n"));
  assert.deepEqual(turns, turnsBefore);
  assert.equal(window.targetBytes + window.promptTextBytes <= 70, true);
  assert.equal(window.expected.length, 2);
  assert.equal(historyWindowOracle(turns, 5, 95).omittedMessages, 0);
  assert.equal(historyWindowOracle(turns, 5, 35).budgetExceeded, true);
  const consecutive = [{ role: "user", content: "x".repeat(40) }, { role: "user", content: "u" },
    { role: "assistant", content: [text("x".repeat(40))], stopReason: "stop" }];
  assert.equal(historyWindowOracle(consecutive, 0, 50).budgetExceeded, true);
  const promptGuard = historyWindowOracle(turns, 185001, 70);
  assert.deepEqual([promptGuard.promptExceeded, promptGuard.budgetExceeded, promptGuard.omittedMessages], [true, false, 0]);
  assert.equal(historyWindowOracle([source[0], pending, ...turns.slice(3)], 0, 50).rejectedAdmission, "interleaved_tool_batch");
  assert.equal(historyWindowOracle([{ role: "user", content: "u" }, pending, { ...source[2], isError: false }], 0).targetBytes, 15);
  const pngHeader = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
  const longTurns = [turns[0], { ...turns[1], content: [text("x".repeat(400000))] }, turns[2],
    { role: "user", content: [text("x".repeat(250000)), { type: "image", mimeType: "image/png", data: pngHeader }] },
    { role: "assistant", content: [text("x".repeat(300000))], stopReason: "stop" }];
  const longWindow = historyWindowOracle(longTurns, 10);
  assert.equal(projectedText(longWindow.expected[0].parts[0].text, 185000), "[Pi omitted 3 earlier messages]\n\n" + "x".repeat(92452) + "\n\n[Pi omitted 65062 bytes]\n\n" + "x".repeat(92486));
  assert.equal(longWindow.expected[0].parts[1].data, pngHeader);
  assert.equal(longWindow.omittedTargetBytes, 400003);
  assert.equal(longWindow.markerNetBytes, 0);
  assert.equal(compareHistory(window.expected, window.expected.slice(1)).differences.includes("message_count"), true);
  const extraClip = structuredClone(longWindow.expected);
  extraClip[0].parts[0].text = "[Pi omitted 3 earlier messages]\n\n" + "x".repeat(92451) + "\n\n[Pi omitted 65064 bytes]\n\n" + "x".repeat(92485);
  assert.equal(compareHistory(longWindow.expected, extraClip).differences.includes("text"), true);
  assert.equal(historyWindowOracle([turns[2]], 1).rejectedAdmission, "empty_projected_history");
  assert.equal(historyWindowOracle([turns[2]], 185001).promptExceeded, true);
  assert.equal(historyWindowOracle([], 1).rejectedAdmission, undefined);
  assert.equal(networkProfile(["/synthetic/default"]).includes('(deny file-read* file-write* (subpath "/synthetic/default"))'), true);
  assert.equal(networkProfile(['/synthetic/"quoted']).includes('(subpath "/synthetic/\\"quoted")'), true);
  assert.equal(networkProfile(["/synthetic/default"]).includes("(deny network*)"), true);
  assert.equal(networkProfile().includes("(deny file-read*"), false);
  const priorMetadata = new Map([["prior.db", [1, 2, 3]]]);
  assert.equal(compareSessionMetadata(priorMetadata, new Map([...priorMetadata, ["own.db", [4]]]), "own").existingSessionMetadataUnchanged, true);
  assert.equal(compareSessionMetadata(priorMetadata, new Map([["prior.db", [1, 2, 4]]]), "own").existingSessionMetadataChanges, 1);
  assert.equal(compareSessionMetadata(priorMetadata, new Map(), "own").existingSessionMetadataChanges, 1);
  assert.equal(compareSessionMetadata(priorMetadata, new Map([...priorMetadata, ["external.db", [4]]]), "own").unrelatedSessionEntriesAdded, 1);
  assert.equal(compareSessionMetadata(priorMetadata, new Map([...priorMetadata, ["own.db.unrelated", [4]]]), "own").unrelatedSessionEntriesAdded, 1);
  const rpcCases = [
    ["creator_new", "session/new", undefined, undefined, "creator_new_pending"],
    ["creator_new_pending", "session/new", undefined, undefined, undefined],
    ["creator_new", "session/new", "own", undefined, undefined],
    ["creator_close", "session/close", "own", "own", "creator_done"],
    ["creator_close", "session/close", "own", "other", undefined],
    ["creator_done", "session/new", "own", undefined, undefined],
    ["worker_resume", "session/new", "own", undefined, undefined],
    ["worker_resume", "session/resume", "own", "own", "worker_resume_pending"],
    ["worker_resume_pending", "session/resume", "own", "own", undefined],
    ["worker_resume", "session/resume", "own", "other", undefined],
    ["worker_close", "session/close", "own", "own", "worker_done"],
    ["worker_done", "session/resume", "own", "own", undefined],
    ["worker_close", "session/prompt", "own", "own", undefined],
    ["creator_new", "authenticate", undefined, undefined, undefined],
  ];
  for (const [stage, method, own, requested, next] of rpcCases) assert.equal(profileRpcNextStage(stage, method, own, requested), next);
  assert.equal(defaultProfileOverridesPresent({ AGY_ACP_BIN: "/synthetic/launcher" }), true);
  assert.equal(defaultProfileOverridesPresent({ GEMINI_API_KEY: "synthetic" }), true);
  assert.equal(defaultProfileOverridesPresent({ SSH_TTY: "synthetic" }), false);
  const completionAbort = { stopReason: "aborted", errorMessage: "Profile check completed before any prompt" };
  assert.equal(expectedProfileCompletion(completionAbort, true, false), true);
  assert.equal(expectedProfileCompletion(completionAbort, false, false), false);
  assert.equal(expectedProfileCompletion(completionAbort, true, true), false);
  assert.equal(expectedProfileCompletion({ ...completionAbort, errorMessage: "Other cancellation" }, true, false), false);
  assert.equal(expectedProfileCompletion({ ...completionAbort, stopReason: "error" }, true, false), false);
  return 100 + rpcCases.length + systemDefaultChecks;
}

function revision2SelfTest() {
  const assert = require("node:assert/strict");
  let checks = 0;
  const same = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
  const text = text => ({ type: "text", text });
  const user = content => ({ role: "user", content });
  const assistant = value => ({ role: "assistant", content: [text(value)], stopReason: "stop" });
  const thinking = () => ({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }], stopReason: "stop" });
  const call = id => ({ type: "toolCall", id, name: "fixture", arguments: {} });
  const result = (id, value) => ({ role: "toolResult", toolCallId: id, toolName: "fixture", isError: false, content: [text(value)] });
  const batch = (...calls) => ({ role: "assistant", stopReason: "toolUse", content: calls });
  const head = n => `[Pi omitted ${n} earlier ${n === 1 ? "message" : "messages"}]\n\n`;
  const tail = n => `\n\n[Pi omitted ${n} intermediate ${n === 1 ? "message" : "messages"}]\n\n`;
  const bytes = value => Buffer.byteLength(value);

  // Full history fits exactly without markers.
  const full = [user("u"), assistant("a")];
  same(historyWindowOracle(full, 3, 5).expected, expectedHistory(full));
  same(historyWindowOracle(full, 3, 4).budgetExceeded, true);

  // Complete rounds take precedence over intra-round candidates.
  const rounds = [user("old"), assistant("x".repeat(200)), user("new"), assistant("y".repeat(80)), assistant("last")];
  const whole = historyWindowOracle(rounds, 0, 120);
  same(whole.omittedMessages, 2);
  same(whole.intraOmittedMessages, 0);
  same(whole.expected, expectedHistory([user(head(2) + "new"), ...rounds.slice(3)]));

  // Two disjoint gaps, consecutive users, and a complete parallel batch.
  const dual = [user("old"), assistant("x".repeat(200)), thinking(), user("u1"), user("u2"),
    thinking(), assistant("y".repeat(200)), thinking(), batch(call("a"), call("b")),
    result("b", "B"), result("a", "A"), thinking(), assistant("")];
  const before = structuredClone(dual), window = historyWindowOracle(dual, 0, 100);
  same(dual, before);
  same(window.omittedMessages, 3);
  same(window.omittedTargetBytes, 203);
  same(window.markerNetBytes, bytes(head(3)));
  same(window.intraOmittedMessages, 3);
  same(window.intraOmittedTargetBytes, 200);
  same(window.intraMarkerNetBytes, bytes(tail(3)));
  same(window.expected, expectedHistory([user(head(3) + "u1"), user("u2" + tail(3)), ...dual.slice(8)]));
  same(window.targetBytes, 4 + bytes(head(3)) + bytes(tail(3)) + 4 + 2);
  same(window.expected.at(-1).parts[0].text, "B");

  // Current ACP includes its two-LF separator and participates in exact bounds.
  const current = livePromptOracle([user("A"), user("B")], 0);
  const currentBytes = current.blocks.reduce((sum, block) => sum + (block.type === "text" ? bytes(block.text) : 0), 0);
  same(currentBytes, 4);
  same(historyWindowOracle(dual, currentBytes, window.targetBytes + 4).budgetExceeded, false);
  same(historyWindowOracle(dual, currentBytes, window.targetBytes + 3).budgetExceeded, true);

  // Earlier call batches are removed atomically, including every result.
  const dropBatch = [user("u"), batch(call("drop-a"), call("drop-b")),
    result("drop-b", "x".repeat(200)), result("drop-a", "y".repeat(200)), thinking(), assistant("keep")];
  const dropped = historyWindowOracle(dropBatch, 0, 60);
  same(dropped.intraOmittedMessages, 4);
  same(dropped.intraOmittedTargetBytes, 404);
  same(dropped.expected, expectedHistory([user("u" + tail(4)), assistant("keep")]));

  // Choose the earliest fitting continuous visible-group suffix.
  const earliest = [user("u"), assistant("x".repeat(200)), assistant("b"), assistant("c")];
  const earliestWindow = historyWindowOracle(earliest, 0, 50);
  same(earliestWindow.intraOmittedMessages, 1);
  same(earliestWindow.expected, expectedHistory([user("u" + tail(1)), assistant("b"), assistant("c")]));

  // Empty text and thinking cannot replace the mandatory last visible group.
  const mandatory = [user("u"), assistant("x".repeat(200)), assistant("z".repeat(100)), thinking(), assistant("")];
  const noFit = historyWindowOracle(mandatory, 0, 60);
  same(noFit.budgetExceeded, true);
  same(noFit.intraOmittedMessages, 0);
  same(noFit.expected, expectedHistory(mandatory));
  const onlyBatch = [user("u"), thinking(), batch(call("only-a"), call("only-b")),
    result("only-a", "x".repeat(200)), result("only-b", "y"), thinking(), assistant("")];
  same(historyWindowOracle(onlyBatch, 0, 80).budgetExceeded, true);

  // Compose both markers on original user text before a single projection.
  const png = { type: "image", mimeType: "image/png", data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64") };
  const raw = "H" + "x".repeat(249998) + "T";
  const long = [user("old"), assistant("x".repeat(400000)), thinking(), user([text(raw), png]),
    thinking(), assistant("y".repeat(400000)), thinking(), assistant("keep")];
  const longBefore = structuredClone(long), clipped = historyWindowOracle(long, 0);
  const marked = head(3) + raw + tail(3);
  same(long, longBefore);
  same(clipped.omittedMessages, 3);
  same(clipped.intraOmittedMessages, 3);
  same(clipped.markerNetBytes, 0);
  same(clipped.intraMarkerNetBytes, 0);
  same(clipped.targetBytes, 185003);
  same(clipped.expected, expectedHistory([user([text(marked), png]), assistant("keep")]));
  same(clipped.expected[0].parts[0].text, marked);
  same(clipped.expected[0].parts[1], { kind: "image", mimeType: png.mimeType, data: png.data });
  same(projectedText(marked, 185000), head(3) + "H" + "x".repeat(92451)
    + "\n\n[Pi omitted 65102 bytes]\n\n" + "x".repeat(92445) + "T" + tail(3));
  same(projectedText(marked, 185000) === projectedText(head(3) + projectedText(raw, 185000) + tail(3), 185000), false);
  same(historyWindowOracle(long, 0, 185003).budgetExceeded, false);
  same(historyWindowOracle(long, 1, 185003).budgetExceeded, true);

  // Over-prompt guard preserves the original history without windowing.
  const over = historyWindowOracle(dual, 185001, 1);
  same(over.promptExceeded, true);
  same(over.budgetExceeded, false);
  same(over.omittedMessages, 0);
  same(over.intraOmittedMessages, 0);
  same(over.expected, expectedHistory(dual));

  // Invalid older prefixes cannot be hidden by either omission mode.
  const invalid = [user("old"), batch(call("missing")), user("new"), assistant("keep")];
  same(historyWindowOracle(invalid, 0, 60).rejectedAdmission, "interleaved_tool_batch");

  const empty = assistant("");
  same(omittableEmptyAssistant(empty), true);
  same(omittableEmptyAssistant({ ...empty, content: [...thinking().content, text("")] }), true);
  same(omittableEmptyAssistant(thinking()), false);
  same(omittableEmptyAssistant(assistant(" ")), false);
  same(omittableEmptyAssistant({ ...empty, stopReason: "toolUse" }), false);
  same(omittableEmptyAssistant({ ...empty, deferred: false }), false);
  same(omittableEmptyAssistant({ ...empty, errorMessage: "" }), false);
  same(omittableEmptyAssistant({ ...empty, content: [text(""), text("")] }), false);
  const leadingEmpty = { ...batch(call("empty-leading")), content: [text(""), call("empty-leading")] };
  same(omittableEmptyAssistant(leadingEmpty), false);
  same(expectedHistory([leadingEmpty])[0].parts.length, 2);
  same(expectedHistory([empty]), []);
  same(expectedHistory([assistant(" ")])[0].parts[0].text, " ");
  const adjacent = [user("A"), empty, user("B"), assistant("keep")];
  const projected = historyWindowOracle(adjacent, 0);
  same(projected.expected.map(message => message.role), ["user", "user", "assistant"]);
  same(projected.omittedEmptyAssistants, 1);
  same(historyWindowOracle([empty], 0).rejectedAdmission, "empty_projected_history");
  same(historyWindowOracle([empty], 0).omittedEmptyAssistants, 0);
  same(historyWindowOracle([user("u"), { ...empty, deferred: false }], 0).rejectedAdmission, "unsupported_assistant_metadata");
  same(historyWindowOracle([user("u"), { ...empty, stopReason: "toolUse" }], 0).rejectedAdmission, "assistant_text_stop_reason");
  same(historyWindowOracle([user("u"), { ...empty, content: [text(""), text("")] }], 0).rejectedAdmission, "unsupported_assistant_layout");
  const emptyGaps = [user("old"), empty, assistant("x".repeat(200)), user("u"), empty,
    assistant("y".repeat(200)), empty, assistant("keep"), { ...empty, content: [...thinking().content, text("")] }];
  const emptyBefore = structuredClone(emptyGaps), kept = historyWindowOracle(emptyGaps, 0, 100);
  same(emptyGaps, emptyBefore);
  same([kept.omittedMessages, kept.intraOmittedMessages, kept.omittedEmptyAssistants], [3, 3, 1]);
  same(kept.expected, [{ role: "user", textBudget: 185000, parts: [{ kind: "text", text: head(3) + "u" + tail(3) }] },
    { role: "assistant", parts: [{ kind: "text", text: "keep" }] }]);
  same(historyWindowOracle(adjacent, 185001).omittedEmptyAssistants, 0);
  same(historyWindowOracle([user("u"), empty, assistant("x".repeat(100)), empty], 0, 50).omittedEmptyAssistants, 0);

  const zeroLosses = { userTruncated: 0, toolResultsTruncated: 0, earlierMessagesOmitted: 0,
    intermediateMessagesOmitted: 0, toolImagesOmitted: 0 };
  same(historyWindowOracle(full, 0).losses, zeroLosses);
  same(over.losses, zeroLosses);
  same(noFit.losses, zeroLosses);
  same(historyWindowOracle(invalid, 0, 60).losses, zeroLosses);
  same(historyWindowOracle([], 0).losses, zeroLosses);
  same(historyWindowOracle([empty], 0).losses, zeroLosses);
  same(window.losses, { ...zeroLosses, earlierMessagesOmitted: 3, intermediateMessagesOmitted: 3 });
  same(clipped.losses, { ...zeroLosses, userTruncated: 1, earlierMessagesOmitted: 3, intermediateMessagesOmitted: 3 });
  same(earliestWindow.expected[0].parts[0].text, "u\n\n[Pi omitted 1 intermediate message]\n\n");
  const singular = historyWindowOracle([assistant("x".repeat(500000)), user("u"), assistant("keep")], 0);
  same(singular.expected[0].parts[0].text, "[Pi omitted 1 earlier message]\n\nu");
  same(singular.losses, { ...zeroLosses, earlierMessagesOmitted: 1 });
  same(whole.expected[0].parts[0].text, "[Pi omitted 2 earlier messages]\n\nnew");
  same(dropped.expected[0].parts[0].text, "u\n\n[Pi omitted 4 intermediate messages]\n\n");

  // Source image blocks count even when the placeholder is subsequently cropped.
  // Identical literal text is never evidence of an omitted image.
  const imageResult = id => ({ ...result(id, "r".repeat(60000)), content: [text("r".repeat(60000)), png] });
  const literal = [user("[Pi omitted an image]"), batch(call("literal")), result("literal", "[Pi omitted an image]")];
  same(historyWindowOracle(literal, 0).losses, zeroLosses);
  same(expectedHistory([imageResult("image")])[0].parts[0].text, "r".repeat(60000) + "\n[Pi omitted an image]");
  const retained = [user(raw), batch(call("success"), call("error")), imageResult("success"),
    { ...imageResult("error"), isError: true }];
  const retainedBefore = structuredClone(retained), retainedWindow = historyWindowOracle(retained, 0);
  same(retainedWindow.losses, { ...zeroLosses, userTruncated: 1, toolResultsTruncated: 2, toolImagesOmitted: 2 });
  same(retained, retainedBefore);
  same(retainedWindow.omittedMessages, 0);
  same(retainedWindow.expected.slice(-2).map(message => message.textBudget), [49152, 49115]);
  // 60022 original bytes reserve a 28-byte marker: 49124/49087 kept.
  same(projectedText(retainedWindow.expected[2].parts[0].text, 49152), "r".repeat(24562)
    + "\n\n[Pi omitted 10898 bytes]\n\n" + "r".repeat(24540) + "\n[Pi omitted an image]");
  same(projectedText(retainedWindow.expected[3].parts[0].text, 49115), "r".repeat(24543)
    + "\n\n[Pi omitted 10935 bytes]\n\n" + "r".repeat(24522) + "\n[Pi omitted an image]");

  // Neither discarded gap contributes user/result truncations or image loss.
  const lossGaps = [user(raw), batch(call("old-image")), imageResult("old-image"), assistant("x".repeat(500000)),
    user("u"), batch(call("gap-image")), imageResult("gap-image"), assistant("y".repeat(500000)),
    batch(call("kept-image")), imageResult("kept-image")];
  const gapWindow = historyWindowOracle(lossGaps, 0);
  same([gapWindow.omittedMessages, gapWindow.intraOmittedMessages], [4, 3]);
  same(gapWindow.losses, { ...zeroLosses, toolResultsTruncated: 1, earlierMessagesOmitted: 4,
    intermediateMessagesOmitted: 3, toolImagesOmitted: 1 });
  const markerOnlyCrop = structuredClone(long);
  markerOnlyCrop[3].content[0].text = "x".repeat(185000);
  same(historyWindowOracle(markerOnlyCrop, 0).losses, { ...zeroLosses, userTruncated: 1,
    earlierMessagesOmitted: 3, intermediateMessagesOmitted: 3 });
  const exactResults = [user("u"), batch(call("exact-success"), call("exact-error")),
    result("exact-success", "x".repeat(49152)), { ...result("exact-error", "x".repeat(49115)), isError: true }];
  same(historyWindowOracle(exactResults, 0).losses, zeroLosses);
  exactResults[2].content[0].text += "x";
  exactResults[3].content[0].text += "x";
  same(historyWindowOracle(exactResults, 0).losses, { ...zeroLosses, toolResultsTruncated: 2 });
  return checks;
}

function compareImportLossReports(expected, reports, dispatched) {
  const expectedReports = Number(dispatched && Object.values(expected).some(count => count > 0));
  const matches = reports.length === expectedReports && (!expectedReports || isDeepStrictEqual(expected, reports[0]));
  return { expectedReports, actualReports: reports.length, verifiedReports: matches ? expectedReports : 0,
    differences: matches ? [] : ["history_loss_report"] };
}

function importLossReportSelfTest() {
  const assert = require("node:assert/strict");
  const zero = { userTruncated: 0, toolResultsTruncated: 0, earlierMessagesOmitted: 0, intermediateMessagesOmitted: 0, toolImagesOmitted: 0 };
  const positive = { ...zero, userTruncated: 1, intermediateMessagesOmitted: 2 };
  assert.deepEqual(compareImportLossReports(zero, [], true), { expectedReports: 0, actualReports: 0, verifiedReports: 0, differences: [] });
  assert.deepEqual(compareImportLossReports(positive, [structuredClone(positive)], true), { expectedReports: 1, actualReports: 1, verifiedReports: 1, differences: [] });
  assert.deepEqual(compareImportLossReports(positive, [], true).differences, ["history_loss_report"]);
  assert.deepEqual(compareImportLossReports(positive, [positive, positive], true).differences, ["history_loss_report"]);
  assert.deepEqual(compareImportLossReports(positive, [], false).differences, []);
  assert.deepEqual(compareImportLossReports(zero, [zero], true).differences, ["history_loss_report"]);
  const unexpected = compareImportLossReports(positive, [{ ...positive, extra: "PRIVATE_SENTINEL" }], true);
  assert.deepEqual(unexpected.differences, ["history_loss_report"]);
  assert.equal(JSON.stringify(unexpected).includes("PRIVATE_SENTINEL"), false);
  return 8;
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}
function stopServer(server) {
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}
function networkProfile(protectedRoots = []) {
  // Synthetic-only authorization: native RPC uses dynamically assigned loopback
  // listeners. Local forward proxies remain a residual risk for real payloads.
  return `(version 1) (allow default) (deny network*)
    (allow network-bind (local tcp "localhost:*"))
    (allow network-inbound (local tcp "localhost:*"))
    (allow network-outbound (remote tcp "localhost:*"))
    ${protectedRoots.map(root => `(deny file-read* file-write* (subpath ${JSON.stringify(root)}))`).join("\n    ")}`;
}

function protectedProfileRoots() {
  const roots = [join(userInfo().homedir, ".gemini"), join(process.env.HOME || homedir(), ".gemini")];
  if (process.env.GEMINI_HOME) roots.push(resolve(process.env.GEMINI_HOME));
  return [...new Set(roots.flatMap(root => existsSync(root) ? [root, realpathSync(root)] : [root]))];
}

function cleanEnvironment(home) {
  return { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: home, LANG: "en_US.UTF-8" };
}

// This proof uses no Pi data or native CLI. A successful run demonstrates both
// direct enforcement and inheritance to a child launched inside the sandbox.
async function verifyIsolation() {
  const servers = [], endpoints = [];
  let guardRoot;
  try {
    guardRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-history-isolation-")));
    const blocked = join(guardRoot, "blocked"), sentinel = join(blocked, "sentinel");
    mkdirSync(blocked, { mode: 0o700 });
    writeFileSync(sentinel, "synthetic isolation sentinel", { mode: 0o600, flag: "wx" });
    for (let index = 0; index < 2; index++) {
      const server = createServer((_request, response) => response.end("OK"));
      servers.push(server);
      endpoints.push({ host: "127.0.0.1", port: await listen(server) });
    }
    // A public TCP handshake only: no HTTP, credentials, or history payload.
    // An on-host non-loopback interface is still treated as localhost by macOS.
    endpoints.push({ host: "1.1.1.1", port: 443, tcp: true });
    const probe = `
      const http = require('node:http');
      function connect(endpoint) {
        if (endpoint.tcp) return new Promise(resolve => {
          const socket = require('node:net').createConnection({host:endpoint.host,port:endpoint.port});
          socket.setTimeout(5000, () => { resolve('failed'); socket.destroy(); });
          socket.once('connect', () => { resolve('connected'); socket.destroy(); });
          socket.once('error', error => resolve(['EPERM','EACCES'].includes(error.code) ? 'denied' : 'failed'));
        });
        return new Promise(resolve => {
          const request = http.get({...endpoint,path:'/'}, response => {
            response.resume(); response.once('end', () => resolve(response.statusCode === 200));
          });
          request.setTimeout(3000, () => request.destroy());
          request.once('error', () => resolve(false));
        });
      }
      async function probe() {
        const results = await Promise.all(${JSON.stringify(endpoints)}.map(connect));
        const local = http.createServer((_request,response) => response.end('OK'));
        const bound = await new Promise(resolve => {
          local.once('error', () => resolve(false));
          local.listen(0,'127.0.0.1', () => resolve(true));
        });
        const roundtrip = bound && await connect({host:'127.0.0.1',port:local.address().port});
        if (bound) { local.closeAllConnections(); await new Promise(resolve => local.close(resolve)); }
        const fs = require('node:fs'), sentinel = ${JSON.stringify(sentinel)};
        const access = operation => {
          try { operation(); return 'allowed'; }
          catch (error) { return ['EPERM','EACCES'].includes(error.code) ? 'denied' : 'failed'; }
        };
        return [...results, roundtrip, access(() => fs.readFileSync(sentinel)),
          access(() => fs.writeFileSync(sentinel, 'synthetic isolation sentinel'))];
      }
    `;
    // Require external baseline reachability; a timeout cannot count as denial.
    const baseline = await runFile(process.execPath, ["-e", probe + "probe().then(x => process.stdout.write(JSON.stringify(x)))"], { timeout: 10000 });
    if (!isDeepStrictEqual(JSON.parse(baseline.stdout), [true, true, "connected", true, "allowed", "allowed"])) throw new Error("isolation_baseline");
    const child = probe + "probe().then(x => process.stdout.write(JSON.stringify(x)))";
    const code = probe + `
      probe().then(async direct => {
        const {execFile} = require('node:child_process');
        const {promisify} = require('node:util');
        const child = await promisify(execFile)(process.execPath, ['-e', ${JSON.stringify(child)}], {timeout:10000});
        process.stdout.write(JSON.stringify([direct, JSON.parse(child.stdout)]));
      }).catch(() => process.exit(1));
    `;
    const result = await runFile("/usr/bin/sandbox-exec", ["-p", networkProfile([blocked]), process.execPath, "-e", code], {
      timeout: 20000, env: cleanEnvironment("/tmp"), maxBuffer: 4096,
    });
    const checks = JSON.parse(result.stdout);
    if (!isDeepStrictEqual(checks, [[true, true, "denied", true, "denied", "denied"], [true, true, "denied", true, "denied", "denied"]])) {
      const error = new Error("isolation_not_enforced");
      error.observedChecks = checks;
      throw error;
    }
    if (readFileSync(sentinel, "utf8") !== "synthetic isolation sentinel") throw new Error("isolation_sentinel_changed");
    return { isolationChecks: 12, networkIsolationChecks: 8, filesystemIsolationChecks: 4, failed: 0, loopbackProxyRisk: 1 };
  } finally {
    await Promise.allSettled(servers.map(stopServer));
    if (guardRoot) rmSync(guardRoot, { recursive: true });
  }
}

// The fixed endpoint forwards to the dynamically allocated production listener.
// Headers/body and the production permission handler stay intact. The proxy
// cannot be used to select arbitrary upstream endpoints.
async function mcpProxy() {
  let target;
  const server = createServer((incoming, outgoing) => {
    if (!target || incoming.url !== "/mcp") { outgoing.writeHead(503).end(); return; }
    const upstream = httpRequest(target, {
      method: incoming.method, headers: { ...incoming.headers, host: target.host },
    }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  const port = await listen(server);
  return {
    port,
    pointAt(descriptor) {
      const url = new URL(descriptor.url);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp") throw new Error("invalid_mcp_target");
      target = url;
      return { ...descriptor, url: `http://127.0.0.1:${port}/mcp` };
    },
    close: () => stopServer(server),
  };
}

// Independent source guards: production still makes the admission decision.
// Window planning must not hide an invalid older prefix. This helper creates no
// writer data and supplies no comparison text.
function admissionReason(messages) {
  const textValid = text => typeof text === "string" && text.isWellFormed();
  const jsonValid = value => typeof value === "string" ? value.isWellFormed()
    : typeof value === "number" ? Number.isFinite(value) && !Object.is(value, -0)
    : value === null || typeof value === "boolean" ? true
    : Array.isArray(value) ? value.every(jsonValid)
    : value && typeof value === "object" && Object.entries(value).every(([key, item]) => key.isWellFormed() && jsonValid(item));
  const ids = new Set();
  if (!messages.length) return "empty_history";
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "user") {
      if (typeof message.content === "string") { if (!textValid(message.content)) return "invalid_user_text"; continue; }
      const blocks = message.content;
      if (!Array.isArray(blocks) || ![1, 2].includes(blocks.length) || blocks[0]?.type !== "text") return "unsupported_user_layout";
      if (!textValid(blocks[0].text)) return "invalid_user_text";
      if (blocks.length === 2) {
        if (blocks[1].type !== "image" || blocks[1].mimeType !== "image/png" || typeof blocks[1].data !== "string") return "unsupported_user_image";
        const bytes = Buffer.from(blocks[1].data, "base64");
        if (bytes.toString("base64") !== blocks[1].data || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "invalid_user_png";
      }
    } else if (message.role === "assistant") {
      if (message.deferred !== undefined || message.errorMessage !== undefined) return "unsupported_assistant_metadata";
      if (!Array.isArray(message.content)) return "unsupported_assistant_layout";
      const blocks = message.content.filter(block => block.type !== "thinking");
      if (!blocks.length) { if (message.content.length && message.stopReason === "stop") continue; return "empty_assistant"; }
      if (blocks[0].type === "text" && !textValid(blocks[0].text)) return "invalid_assistant_text";
      if (blocks.length === 1 && blocks[0].type === "text") { if (message.stopReason !== "stop") return "assistant_text_stop_reason"; continue; }
      const calls = blocks[0].type === "text" ? blocks.slice(1) : blocks;
      if (!calls.length || calls.some(block => block.type !== "toolCall")) return "unsupported_assistant_layout";
      if (message.stopReason !== "toolUse") return "assistant_call_stop_reason";
      const pending = new Map();
      for (const call of calls) {
        if (typeof call.id !== "string" || !call.id || ids.has(call.id)) return "invalid_or_repeated_call_id";
        if (!textValid(call.name) || !call.name) return "invalid_tool_name";
        if (call.argumentsError !== undefined || call.namespace !== undefined) return "unsupported_call_metadata";
        if (!jsonValid(call.arguments)) return "invalid_tool_arguments";
        ids.add(call.id); pending.set(call.id, call.name);
      }
      for (let remaining = calls.length; remaining > 0; remaining--) {
        const result = messages[++index];
        if (!result) return "incomplete_tool_batch";
        if (result.role !== "toolResult") return "interleaved_tool_batch";
        if (!pending.has(result.toolCallId) || pending.get(result.toolCallId) !== result.toolName) return "unmatched_or_repeated_result";
        if (typeof result.isError !== "boolean") return "invalid_result_error_flag";
        if (!Array.isArray(result.content) || !result.content.length || result.content.some(block => !["text", "image"].includes(block.type))) return "unsupported_result_layout";
        if (result.content.some(block => block.type === "text" && !textValid(block.text))) return "invalid_result_text";
        pending.delete(result.toolCallId);
      }
    } else return "orphan_result_or_unsupported_role";
  }
  return "unclassified_admission";
}

async function inspectAdmission() {
  const pi = realpathSync(execFileSync("/usr/bin/which", ["pi"], { encoding: "utf8" }).trim());
  const pkg = join(dirname(dirname(pi)), "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
  const sdk = { ...await import(pathToFileURL(join(pkg, "dist/core/session-manager.js"))), ...await import(pathToFileURL(join(pkg, "dist/core/messages.js"))) };
  const { prepareHistory } = await import(pathToFileURL(join(__dirname, "../antigravity/history.ts")));
  const { getCurrentSystemMessage } = await import(pathToFileURL(join(pkg, "node_modules/@earendil-works/pi-ai/dist/utils/transcript.js")));
  const { getSystemMessageText } = await import(pathToFileURL(join(pkg, "node_modules/@earendil-works/pi-ai/dist/utils/text.js")));
  const counts = { newSnapshot: 1, nativeStarted: 0, requested: 30, scanned: 0, invalid: 0, selected: 0, accepted: 0, rejected: 0,
    roles: { system: 0, user: 0, assistant: 0, toolResult: 0, other: 0 }, omittedFailedAssistants: { error: 0, aborted: 0 },
    system: { promptOnly: 0, toolDeltaOnly: 0, promptAndToolDelta: 0, empty: 0, content: 0, sections: 0, toolsAdded: 0, toolsRemoved: 0 },
    systemProvenance: { messageEntries: 0, compactionSnapshots: 0, otherEntries: 0 }, effectiveRecordedSystemPromptBytes: 0, sessionsWithRecordedSystemPrompt: 0, externalAppends: 0, sourceChanged: 0, rejectionReasons: {}, rejectedSamples: [] };
  for (const [index, sample] of selectSessions(join(homedir(), ".local/state/pi/sessions"), sdk, counts, 30, true).entries()) {
    for (const [kind, count] of Object.entries(sample.systemProvenance)) counts.systemProvenance[kind] += count;
    const systemValid = validSystemSources(sample.messages);
    const system = systemValid ? getCurrentSystemMessage(sample.messages) : undefined;
    if (system) {
      const bytes = Buffer.byteLength(getSystemMessageText(system));
      counts.effectiveRecordedSystemPromptBytes += bytes;
      counts.sessionsWithRecordedSystemPrompt += Number(bytes > 0);
    }
    for (const message of sample.messages) {
      counts.roles[Object.hasOwn(counts.roles, message.role) ? message.role : "other"]++;
      if (message.role !== "system") continue;
      const content = typeof message.content === "string" ? message.content.length > 0 : message.content?.some(block => block.type === "text" && block.text?.length > 0);
      const sections = Object.keys(message.sections ?? {}).length > 0, added = !!message.toolsAdded?.length, removed = !!message.toolsRemoved?.length;
      counts.system.content += Number(!!content); counts.system.sections += Number(sections);
      counts.system.toolsAdded += Number(added); counts.system.toolsRemoved += Number(removed);
      counts.system[content || sections ? (added || removed ? "promptAndToolDelta" : "promptOnly") : added || removed ? "toolDeltaOnly" : "empty"]++;
    }
    const projection = projectFailedAssistants(requestMessages(sample.messages));
    for (const key of ["error", "aborted"]) counts.omittedFailedAssistants[key] += projection.omitted[key];
    const messages = projection.messages.filter(message => message.role !== "system");
    let boundary = messages.length;
    while (boundary > 0 && messages[boundary - 1].role === "user") boundary--;
    const history = messages.slice(0, boundary);
    let admitted = false, reason;
    try {
      const blocks = livePromptOracle(messages.slice(boundary), 0).blocks;
      const promptBytes = blocks.reduce((sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0), 0);
      if (!systemValid) reason = "system_source_shape";
      else if (promptBytes > 185000) reason = "live_prompt_budget_exceeded";
      else { admitted = !!prepareHistory(history, promptBytes); if (!admitted) reason = admissionReason(history); }
    }
    catch (error) { reason = error.message === "Antigravity cannot fit the latest turn. Compact with another model or start a new conversation."
      ? "history_budget_exceeded" : "admission_exception"; }
    const source = sourceStatus(sample);
    if (source.changed) { counts.sourceChanged++; admitted = false; reason = "source_changed"; }
    else if (source.appendedBytes) counts.externalAppends++;
    if (admitted) counts.accepted++;
    else {
      counts.rejected++; counts.rejectionReasons[reason] = (counts.rejectionReasons[reason] ?? 0) + 1;
      counts.rejectedSamples.push({ sampleOrdinal: index + 1, category: reason });
    }
  }
  return counts;
}

function sessionFileMetadata(profile) {
  const directory = join(profile, "conversations"), files = new Map();
  for (const candidate of [profile, directory]) {
    if (existsSync(candidate) && (!lstatSync(candidate).isDirectory() || realpathSync(candidate) !== candidate)) throw new Error("profile_metadata_root");
  }
  if (!existsSync(directory)) return files;
  for (const name of readdirSync(directory)) {
    const stat = lstatSync(join(directory, name));
    files.set(name, [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode]);
  }
  return files;
}

function compareSessionMetadata(before, after, ownId) {
  let changed = 0, added = 0;
  for (const [name, metadata] of before) if (!isDeepStrictEqual(metadata, after.get(name))) changed++;
  const ownFiles = new Set([ownId + ".db", ownId + ".db-wal", ownId + ".db-shm"]);
  for (const name of after.keys()) if (!before.has(name) && !ownFiles.has(name)) added++;
  return { existingSessionMetadataChanges: changed, unrelatedSessionEntriesAdded: added,
    existingSessionMetadataUnchanged: changed === 0 && added === 0 };
}

function profileRpcNextStage(stage, method, ownId, requestedId) {
  if (stage === "creator_new" && method === "session/new" && !ownId) return "creator_new_pending";
  if (ownId && requestedId === ownId) {
    if (stage === "creator_close" && method === "session/close") return "creator_done";
    if (stage === "worker_resume" && method === "session/resume") return "worker_resume_pending";
    if (stage === "worker_close" && method === "session/close") return "worker_done";
  }
  return undefined;
}

function defaultProfileOverridesPresent(env) {
  return ["AGY_ACP_BIN", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"].some(name => name in env);
}

function expectedProfileCompletion(result, completed, signalAborted) {
  return completed && !signalAborted && result.stopReason === "aborted"
    && result.errorMessage === "Profile check completed before any prompt";
}

// Exercise the production importer, then stop at an actual successful resume.
// No model selection, authentication RPC, or prompt is dispatched by this check.
async function profileRoundtrip(runtime, { cwd, geminiDir, env, opening = (_phase, connect) => connect() }) {
  const profile = join(geminiDir, "antigravity-cli"), before = sessionFileMetadata(profile);
  const connections = [], openedPhases = new Set(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const evidence = { created: 0, creatorStopped: 0, writtenSteps: 0, resumedSameId: 0, workerStopped: 0,
    forbiddenRpcAttempts: 0, promptAttempts: 0, authenticateAttempts: 0, promptCalls: 0, authenticateCalls: 0, toolCalls: 0, closeFailures: 0, expectedCompletionAbort: 0 };
  let sessionId, identity, completed = false, failureCategory = "profile_roundtrip_incomplete";
  const fail = category => { failureCategory = category; throw new Error(category); };
  const model = { ...runtime.ai.getModel("anthropic", "claude-haiku-4-5"), id: "profile-check-not-dispatched", provider: "antigravity", api: "antigravity" };
  const bridge = runtime.createAntigravityBridge({ cwd: () => cwd, piSessionId: () => "local-profile-roundtrip",
    connect: async (workingDirectory, callbacks, tools, overrides, signal, profileOptions) => {
      if (workingDirectory !== cwd || profileOptions?.geminiDir !== geminiDir || profileOptions?.appDataDir !== undefined) fail("profile_roundtrip_root");
      const creator = profileOptions.historyTarget === true;
      if (openedPhases.has(creator)) fail("profile_check_connection_count");
      openedPhases.add(creator);
      if (!creator) {
        if (!sessionId || !evidence.creatorStopped || !identity) fail("creator_stop_unverified");
        const database = join(profile, "conversations", sessionId + ".db"), stat = lstatSync(database);
        if (!stat.isFile() || realpathSync(database) !== database || stat.dev !== identity.dev || stat.ino !== identity.ino) fail("new_database_identity");
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(database, { readOnly: true });
        try {
          const rows = db.prepare("SELECT cascade_id FROM trajectory_meta").all();
          if (rows.length !== 1 || rows[0].cascade_id !== sessionId) fail("new_database_identity");
          evidence.writtenSteps = Number(db.prepare("SELECT COUNT(*) AS count FROM steps").get().count);
          if (evidence.writtenSteps !== 2) fail("new_database_steps");
        } finally { db.close(); }
      }
      const connection = await opening(creator ? "neighbor_creator_" : "neighbor_worker_", () => runtime.createAcpConnection(workingDirectory,
        { ...callbacks, tool: async () => { evidence.toolCalls++; throw new Error("profile_check_tools_forbidden"); } }, tools, overrides, signal, profileOptions));
      let stopped = false, stage = creator ? "creator_new" : "worker_resume";
      const close = async () => {
        await connection.close();
        if (stopped) return;
        stopped = true;
        if (creator) {
          evidence.creatorStopped++;
          if (sessionId) {
            const database = join(profile, "conversations", sessionId + ".db"), stat = lstatSync(database);
            if (!stat.isFile() || realpathSync(database) !== database) fail("new_database_identity");
            identity = { dev: stat.dev, ino: stat.ino };
          }
        } else evidence.workerStopped++;
      };
      connections.push({ close });
      const request = async (method, params, settings) => {
        const nextStage = profileRpcNextStage(stage, method, sessionId, params?.sessionId);
        if (!nextStage) {
          evidence.forbiddenRpcAttempts++;
          if (method === "session/prompt") evidence.promptAttempts++;
          if (method === "authenticate") evidence.authenticateAttempts++;
          fail("profile_check_forbidden_rpc");
        }
        stage = nextStage;
        const result = await connection.request(method, params, settings);
        if (method === "session/new") {
          if (!creator || sessionId || !/^[0-9a-f-]{36}$/i.test(result.sessionId ?? "")
            || [...before.keys()].some(name => name.toLowerCase().startsWith(result.sessionId.toLowerCase() + ".db"))) fail("new_session_not_proven");
          sessionId = result.sessionId;
          evidence.created++;
          stage = "creator_close";
        }
        if (method === "session/resume") {
          if (creator || result.sessionId !== sessionId) fail("resume_identity");
          evidence.resumedSameId++;
          stage = "worker_close";
          await request("session/close", { sessionId }, { timeoutMs: 5000 });
          await close();
          completed = true;
          throw new DOMException("Profile check completed before any prompt", "AbortError");
        }
        return result;
      };
      return { ...connection, get closed() { return connection.closed; }, close, request };
    } });
  try {
    const result = await bridge.streamSimple(model, runtime.ai.normalizeContext({ systemPrompt: "Local profile verification. Never execute tools.", tools: [], messages: [
      { role: "user", content: "SYNTHETIC_PROFILE_CHECK_HISTORY", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "SYNTHETIC_PROFILE_CHECK_REPLY" }], stopReason: "stop", timestamp: 0 },
      { role: "user", content: "THIS_PROMPT_MUST_NOT_BE_SENT", timestamp: 0 },
    ] }), { env, signal: controller.signal }).result();
    evidence.expectedCompletionAbort = Number(expectedProfileCompletion(result, completed, controller.signal.aborted));
    if (!completed && result.errorMessage?.includes("(-32000)")) failureCategory = "authentication_required";
  } catch { /* Only fixed categories leave this verification. */ }
  finally {
    clearTimeout(timer);
    for (const connection of connections) try { await connection.close(); } catch { evidence.closeFailures++; }
    bridge.reset();
  }
  const metadata = compareSessionMetadata(before, sessionFileMetadata(profile), sessionId ?? "uncreated");
  const passed = Number(completed && evidence.expectedCompletionAbort && evidence.created === 1 && evidence.writtenSteps === 2 && evidence.resumedSameId === 1
    && !evidence.forbiddenRpcAttempts && !evidence.toolCalls && !evidence.closeFailures && metadata.existingSessionMetadataUnchanged);
  return { sessionId, profile, evidence: { ...evidence, ...metadata, passed,
    ...(passed ? {} : { failureCategory: completed && !metadata.existingSessionMetadataUnchanged ? "existing_session_metadata_changed_unattributed" : failureCategory }),
    harnessTokenContentsRead: 0, harnessExistingSessionContentsRead: 0, fullExistingContentsCompared: 0,
    stoppedScope: "direct_children_only", completeLifetimeProof: 0 } };
}

function assertSyntheticReadPaths(profile, sessionId, caseRoot) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !profile.startsWith(caseRoot + "/") || realpathSync(caseRoot) !== caseRoot) throw new Error("synthetic_read_boundary");
  for (const directory of [profile, join(profile, "conversations")]) {
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new Error("synthetic_read_boundary");
  }
  for (const file of [join(profile, "conversation_summaries.db"), join(profile, "conversations", sessionId + ".db")]) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = file + suffix, stat = lstatSync(candidate, { throwIfNoEntry: false });
      if (!stat && suffix) continue;
      if (!stat?.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || realpathSync(candidate) !== candidate) throw new Error("synthetic_read_boundary");
    }
  }
}

function syntheticSessionSnapshot(profile, sessionId, caseRoot) {
  assertSyntheticReadPaths(profile, sessionId, caseRoot);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(join(profile, "conversation_summaries.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?").get(sessionId);
    if (!row) throw new Error("synthetic_summary_missing");
    const database = join(profile, "conversations", sessionId + ".db");
    return { database: ["", "-wal", "-shm"].map(suffix => existsSync(database + suffix) ? digest(readFileSync(database + suffix)) : null), summary: row };
  } finally { db.close(); }
}

async function verifyDefaultProfile() {
  if (defaultProfileOverridesPresent(process.env)) throw new Error("profile_check_override");
  const geminiDir = realpathSync(resolve(process.env.GEMINI_HOME || join(process.env.HOME || homedir(), ".gemini")));
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-history-profile-check-"))), cwd = join(root, "cwd");
  mkdirSync(cwd, { mode: 0o700 });
  const result = await profileRoundtrip(await loadRuntime(), { cwd, geminiDir, env: undefined });
  const summary = { mode: "default-profile-zero-prompt", verificationRoot: root, ...result.evidence,
    fakeBackend: 0, consumerProfileMustBeConfirmedByOperator: 1, nativeResumeEntryRetained: Number(!!result.sessionId) };
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary) + "\n", { mode: 0o600, flag: "wx" });
  return summary;
}

async function loadRuntime() {
  const pi = realpathSync(execFileSync("/usr/bin/which", ["pi"], { encoding: "utf8" }).trim());
  const pkg = join(dirname(dirname(pi)), "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
  const { createJiti } = require(join(pkg, "node_modules/jiti/lib/jiti.cjs"));
  const jiti = createJiti(__filename, { alias: {
    "@earendil-works/pi-ai/compat": join(pkg, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-ai": join(pkg, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-coding-agent": join(pkg, "dist/index.js"),
  } });
  const manager = await import(pathToFileURL(join(pkg, "dist/core/session-manager.js")));
  const messages = await import(pathToFileURL(join(pkg, "dist/core/messages.js")));
  return {
    ...manager, ...messages,
    ai: await jiti.import("@earendil-works/pi-ai"),
    ...await jiti.import(join(__dirname, "../antigravity/bridge.ts")),
    ...await jiti.import(join(__dirname, "../antigravity/transport.ts")),
  };
}

// Independent read of native runtime framing evidence, never writer preparation.
function wireField(input, wanted) {
  const bytes = Buffer.from(input); let position = 0;
  const integer = () => {
    let value = 0, factor = 1, byte;
    do {
      if (position >= bytes.length || factor > 2 ** 56) throw new Error("native_metadata_shape");
      byte = bytes[position++]; value += (byte & 127) * factor; factor *= 128;
    } while (byte & 128);
    return value;
  };
  while (position < bytes.length) {
    const key = integer(), wire = key % 8;
    let value;
    if (wire === 0) value = integer();
    else if (wire === 2) { const length = integer(); value = bytes.subarray(position, position + length); position += length; }
    else if (wire === 1 || wire === 5) position += wire === 1 ? 8 : 4;
    else throw new Error("native_metadata_shape");
    if (position > bytes.length) throw new Error("native_metadata_shape");
    if (Math.floor(key / 8) === wanted) return value;
  }
}
const RESTART_BODY = "[Notice] All your subagents and background tasks have been stopped due to server restart. If you want a subagent to continue working, it needs to be revived by sending it a new message. If resuming work, please check on status and restart as needed.";
const SETTINGS_NOTICE = "\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.1 Pro (Low). No need to comment on this change if the user doesn't ask about it. If reporting what model you are, please use a human readable name instead of the exact string.\n</USER_SETTINGS_CHANGE>";
function readNativeFraming(database) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(database, { readOnly: true });
  const users = [], notices = [];
  try {
    for (const row of db.prepare("SELECT step_type,metadata,step_payload FROM steps WHERE step_type IN (14,101) ORDER BY idx").all()) {
      if (row.step_type === 14) {
        const seconds = wireField(wireField(row.metadata, 1), 1);
        if (!Number.isSafeInteger(seconds)) throw new Error("native_timestamp_shape");
        users.push({ seconds, liveDetails: wireField(wireField(row.step_payload, 19), 12) !== undefined });
      } else {
        const payload = wireField(row.step_payload, 114);
        const line = payload && wireField(payload, 1)?.toString("utf8");
        const start = "[Message] timestamp=", end = " sender=system priority=MESSAGE_PRIORITY_LOW content=" + RESTART_BODY;
        if (typeof line !== "string" || !line.startsWith(start) || !line.endsWith(end)) continue;
        const timestamp = line.slice(start.length, -end.length);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) continue;
        notices.push("The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n" + line + "\n</SYSTEM_MESSAGE>");
      }
    }
    return { users, notices };
  } finally { db.close(); }
}

function decodeRequest(body, framing) {
  if (!Array.isArray(body.contents)) throw new Error("request_shape");
  let userIndex = 0;
  const notices = new Set(framing?.notices ?? []);
  return body.contents.flatMap((message, messageIndex) => {
    if (!["user", "model"].includes(message.role) || !Array.isArray(message.parts)) throw new Error("request_shape");
    if (message.role === "user" && message.parts.length === 1 && notices.delete(message.parts[0].text)) {
      if (messageIndex !== body.contents.length - 1) throw new Error("native_notice_position");
      return [];
    }
    const userEvidence = message.role === "user" && framing ? framing.users[userIndex++] : undefined;
    const results = message.parts.filter(part => part.functionResponse);
    if (results.length) {
      // Native captures frame function responses as role=model, including
      // parallel response batches. The part type carries tool-result semantics.
      if (message.role !== "model" || results.length !== message.parts.length) throw new Error("mixed_result_shape");
      return results.map(part => {
        const result = part.functionResponse, response = result.response;
        if (result.parts || !result.id || typeof result.name !== "string" || !response || Object.keys(response).length !== 1) throw new Error("result_shape");
        const isError = typeof response.error === "string";
        let text = isError ? response.error : response.output;
        if (typeof text !== "string") throw new Error("result_text_shape");
        if (isError) {
          // Independently observed in all native synthetic error captures.
          const prefix = "Encountered error in tool execution: ";
          if (!text.startsWith(prefix)) throw new Error("result_error_shape");
          text = text.slice(prefix.length);
        }
        return { role: "toolResult", id: result.id, name: result.name.replace(/^mcp_pi_/, ""), isError, parts: [{ kind: "text", text }] };
      });
    }
    return [{ role: message.role === "model" ? "assistant" : "user", parts: message.parts.map(part => {
      if (typeof part.text === "string") {
        if (message.role !== "user" || !framing) return { kind: "text", text: part.text };
        const match = /^<USER_REQUEST>\n([\s\S]*)\n<\/USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ([^\n]+)\.\n<\/ADDITIONAL_METADATA>([\s\S]*)$/.exec(part.text);
        if (!match || !userEvidence || Math.floor(Date.parse(match[2]) / 1000) !== userEvidence.seconds
          || (match[3] !== "" && !(userEvidence.liveDetails && match[3] === SETTINGS_NOTICE))) throw new Error("user_frame_unverified");
        return { kind: "text", text: match[1] };
      }
      if (part.functionCall) return { kind: "call", id: part.functionCall.id, name: part.functionCall.name.replace(/^mcp_pi_/, ""), args: part.functionCall.args };
      if (part.inlineData) return { kind: "image", mimeType: part.inlineData.mimeType, data: part.inlineData.data };
      throw new Error("request_part_shape");
    }) }];
  });
}

// Transport close proves only its direct child stopped. We do not own handles
// for detached native workers: retain the tree, never infer ownership from ps.
function cleanupRoot(root, nativeAttempted) {
  if (nativeAttempted) return false;
  try { rmSync(root, { recursive: true }); return true; } catch { return false; }
}

function directoryBytes(root) {
  if (!lstatSync(root).isDirectory()) throw new Error("profile_not_directory");
  let bytes = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) bytes += directoryBytes(path);
    else if (entry.isFile()) {
      const stat = lstatSync(path);
      if (stat.isFile()) bytes += stat.size;
    }
  }
  return bytes;
}
function distribution(values) {
  const ordered = [...values].sort((a, b) => a - b), n = ordered.length;
  return n ? { count: n, min: ordered[0], median: n % 2 ? ordered[(n - 1) / 2] : (ordered[n / 2 - 1] + ordered[n / 2]) / 2, max: ordered[n - 1], total: ordered.reduce((a, b) => a + b, 0) } : { count: 0 };
}

function lifecycleObserver() {
  const children = [], known = new Map(), departed = new Set(), reparented = new Set(), escaped = new Set(), splitGroups = new Set();
  const checkpoints = {};
  let failed = false, maxLive = 0;
  const identity = row => `${row.pid}:${row.birth}`;
  async function observe(stage) {
    try {
      const output = await runFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { maxBuffer: 4 * 1024 * 1024 });
      const rows = output.stdout.split("\n").flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), birth: match[4] }] : [];
      });
      const current = new Map(rows.map(row => [row.pid, row]));
      for (const child of children) {
        const row = current.get(child.handle.pid);
        // A live self-owned handle is the root of the observed ancestry chain.
        if (!child.birth && row && child.handle.exitCode === null && child.handle.signalCode === null) {
          child.birth = row.birth;
          known.set(identity(row), { ...row, direct: true });
        }
      }
      let added;
      do {
        added = false;
        for (const row of rows) {
          if (known.has(identity(row))) continue;
          const parent = current.get(row.ppid);
          if (parent && known.has(identity(parent))) {
            known.set(identity(row), { ...row, direct: false });
            if (row.pgid !== parent.pgid) splitGroups.add(identity(row));
            added = true;
          }
        }
      } while (added);
      let live = 0, liveDirect = 0, liveDescendants = 0;
      for (const [key, original] of known) {
        const row = current.get(original.pid);
        if (!row || identity(row) !== key) { departed.add(key); continue; }
        live++;
        if (original.direct) liveDirect++; else liveDescendants++;
        if (row.ppid !== original.ppid) reparented.add(key);
        if (row.pgid !== original.pgid) escaped.add(key);
      }
      maxLive = Math.max(maxLive, live);
      checkpoints[stage] = { samples: (checkpoints[stage]?.samples ?? 0) + 1, liveDirect, liveDescendants,
        maxLiveDescendants: Math.max(checkpoints[stage]?.maxLiveDescendants ?? 0, liveDescendants) };
    } catch { failed = true; }
  }
  return {
    async opening(launcher, open, phase = "") {
      const original = childProcess.spawn;
      childProcess.spawn = function (file, ...args) {
        if (file === launcher) args[1] = { ...args[1], detached: true };
        const child = original.call(this, file, ...args);
        if (file === launcher) children.push({ handle: child });
        return child;
      };
      syncBuiltinESMExports();
      try { return await open(); }
      finally {
        childProcess.spawn = original; syncBuiltinESMExports();
        await observe(phase + "transport_open");
      }
    },
    observe,
    summary() {
      return { directStarted: children.length, directStopped: children.filter(child => child.handle.exitCode !== null || child.handle.signalCode !== null).length,
        observedDescendants: [...known.values()].filter(row => !row.direct).length, observedDepartures: departed.size,
        unobservedDirect: children.filter(child => !child.birth).length, reparented: reparented.size, changedGroups: escaped.size, initialGroupSplits: splitGroups.size,
        dedicatedParentGroups: [...known.values()].filter(row => row.direct && row.pid === row.pgid).length,
        maxObservedLive: maxLive, observationFailures: Number(failed), checkpoints, completeLifetimeProof: 0 };
    },
  };
}

async function nativeCase(runtime, input, synthetic = false, runRoot, protectedRoots) {
  if (!Array.isArray(protectedRoots) || !protectedRoots.length) throw new Error("profile_isolation_missing");
  const root = realpathSync(mkdtempSync(join(runRoot ?? tmpdir(), runRoot ? (synthetic ? "smoke-" : "case-") : "pi-history-regression-")));
  const home = join(root, "home"), gemini = join(home, ".gemini"), cwd = join(root, "cwd");
  for (const path of [home, gemini, cwd]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const connections = [], sessionIds = new Set(), requests = [], livePrompts = [];
  let proxy, backend, bridge, callbackCount = 0, imported = false, nativeAttempted = false, profileRoot, databasePath, createdSessionId, firstError, cleaning = false, requestAppend;
  let neighbor, neighborBefore, backendModelRequests = 0;
  const sharedProfileVerification = { expected: Number(synthetic), zeroPromptRoundtrip: 0, neighborDatabaseAndSummaryUnchanged: 0, importedSummaryPresent: 0, verified: 0 };
  let systemBytes = 0, hasSystem = 0, systemVerified = 0, systemToolReferenceMappings = 0, recordedToolDeclarations = 0;
  let sourceUserCount = 0, nativeLiveStepCount = 0, liveUserCoalescing = 0, liveSeparatorBytes = 0, omittedFailedAssistants = { error: 0, aborted: 0 };
  const cleanup = { retainedProfiles: 0, retainedCaseRoots: 0, unprovenWorkers: 0, closeFailures: 0 };
  const diagnosticsEnabled = synthetic && !runRoot;
  const profileBytes = {};
  const lifecycle = lifecycleObserver();
  const differences = new Set();
  const recordError = (stage, error, data) => {
    if (!diagnosticsEnabled || firstError) return;
    const message = typeof error?.message === "string" ? error.message : "";
    const known = /^(?:ACP request failed \(-?\d+\)|ACP request timed out: (?:initialize|session\/(?:new|resume|close|prompt))|Unable to start agy ACP; check the agy executable|Antigravity request aborted|Unsupported Antigravity history version or layout|Invalid Antigravity import session ID)$/;
    firstError = { stage, name: ["Error", "TypeError", "SyntaxError", "AbortError"].includes(error?.name) ? error.name : "unknown",
      ...(typeof error?.code === "number" || ["ENOENT", "EACCES", "EPERM"].includes(error?.code) ? { code: error.code } : {}),
      ...(known.test(message) ? { message } : { category: "unclassified" }) };
    if (data) {
      try { firstError.nativeDatabases = readdirSync(join(data, "conversations"), { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".db")).length; }
      catch { firstError.nativeDatabases = 0; }
      const categories = new Set();
      try {
        for (const entry of readdirSync(join(data, "log"), { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
          const log = readFileSync(join(data, "log", entry.name), "utf8");
          if (/(?:bind|listen)[^\n]{0,200}(?:operation not permitted|permission denied)/i.test(log)) categories.add("bind_denied");
          if (/(?:dial|connect)[^\n]{0,200}(?:operation not permitted|permission denied)/i.test(log)) categories.add("connect_denied");
          if (/(?:sqlite|database)[^\n]{0,200}(?:failed|error|denied)/i.test(log)) categories.add("database_error");
        }
      } catch {}
      firstError.logCategories = [...categories];
    }
  };
  const measure = (stage, path) => {
    try { profileBytes[stage] = directoryBytes(path); } catch { differences.add("profile_size_unavailable"); }
  };
  const original = JSON.stringify(input);
  // Only the history oracle excludes system: the full source transcript goes
  // through SDK normalization and the production current-system/tool path.
  const historyInput = input.filter(message => message.role !== "system");
  let truncations = 0, syntheticArtifact = 0, comparisonDiagnostics, comparisonSummary, knownDifferences = {}, omittedEmptyAssistants = 0;
  const importLossReports = [];
  let expectedHistoryLosses = { userTruncated: 0, toolResultsTruncated: 0, earlierMessagesOmitted: 0, intermediateMessagesOmitted: 0, toolImagesOmitted: 0 };
  let proactiveTrimming = { expected: 0, verified: 0,
    wholeTurn: { messages: 0, targetBytes: 0, markerNetBytes: 0 }, intraTurn: { messages: 0, targetBytes: 0, markerNetBytes: 0 } };
  try {
    if (!validSystemSources(input)) { differences.add("system_source_shape"); throw new Error("system_source_shape"); }
    proxy = await mcpProxy();
    backend = createServer(async (request, response) => {
      try {
        if (!/:(streamGenerateContent|generateContent)(?:\?|$)/.test(request.url)) { response.writeHead(404).end("{}"); return; }
        backendModelRequests++;
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (Array.isArray(body.tools) || (requestAppend && body.systemInstruction?.parts?.some(part => typeof part.text === "string" && part.text.endsWith(requestAppend)))) requests.push(body);
        const reply = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1, totalTokenCount: 21 } };
        const streaming = request.url.includes("streamGenerateContent");
        response.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json" });
        response.end(streaming ? `data: ${JSON.stringify(reply)}\n\n` : JSON.stringify(reply));
      } catch { differences.add("fake_backend"); response.writeHead(500).end("{}"); }
    });
    const backendPort = await listen(backend);
    const agy = realpathSync(execFileSync("/usr/bin/which", ["agy"], { encoding: "utf8" }).trim());
    const launcher = join(root, "native-launcher");
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(launcher, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p ${quote(networkProfile(protectedRoots))} ${quote(agy)} "$@"\n`, { mode: 0o700, flag: "wx" });
    const env = { ...cleanEnvironment(home), GEMINI_HOME: gemini, AGY_ACP_BIN: launcher,
      GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${backendPort}`, GEMINI_API_KEY: "local-fixture-not-a-credential" };
    const defaultProfile = join(gemini, "antigravity-cli");
    mkdirSync(defaultProfile, { mode: 0o700 });
    writeFileSync(join(defaultProfile, "settings.json"), JSON.stringify({ modelProvider: "gemini", setupComplete: true, onboardingComplete: true }), { mode: 0o600, flag: "wx" });
    if (synthetic) {
      nativeAttempted = true;
      profileRoot = defaultProfile;
      neighbor = await profileRoundtrip(runtime, { cwd, geminiDir: gemini, env,
        opening: (phase, connect) => lifecycle.opening(launcher, connect, phase) });
      if (!neighbor.evidence.passed || backendModelRequests) throw new Error("synthetic_neighbor_unverified");
      sharedProfileVerification.zeroPromptRoundtrip = 1;
      neighborBefore = syntheticSessionSnapshot(defaultProfile, neighbor.sessionId, root);
    }
    const model = { ...runtime.ai.getModel("anthropic", "claude-haiku-4-5"), id: "native-default", provider: "antigravity", api: "antigravity" };
    const context = runtime.ai.normalizeContext({ messages: requestMessages(input) });
    const system = structuredClone(runtime.ai.getCurrentSystemMessage(context.messages));
    const systemPrompt = system ? runtime.ai.getSystemMessageText(system) : "";
    const tools = runtime.ai.getCurrentTools(context.messages), toolNames = tools.map(tool => tool.name);
    systemBytes = Buffer.byteLength(systemPrompt); hasSystem = Number(systemBytes > 0); recordedToolDeclarations = tools.length;
    bridge = runtime.createAntigravityBridge({ cwd: () => cwd, piSessionId: () => "local-regression-owner",
      onImport: losses => importLossReports.push(structuredClone(losses)), connect: async (...args) => {
      const [workingDirectory, callbacks, available, overrides, signal, profile] = args;
      if (profile?.appDataDir !== undefined || profile?.geminiDir !== gemini
        || overrides?.HOME !== home || overrides?.GEMINI_HOME !== gemini || workingDirectory !== cwd) throw new Error("profile_isolation_mismatch");
      const data = join(gemini, "antigravity-cli");
      mkdirSync(data, { recursive: true, mode: 0o700 });
      if (realpathSync(data) !== data) throw new Error("profile_isolation_mismatch");
      try {
        writeFileSync(join(data, "settings.json"), JSON.stringify({ modelProvider: "gemini", setupComplete: true, onboardingComplete: true }), { mode: 0o600, flag: "wx" });
      } catch (error) { if (error.code !== "EEXIST") throw error; }
      if (profile?.historyTarget) profileRoot = data;
      else if (profileRoot === data) measure("beforeResume", data);
      nativeAttempted = true;
      const phase = profile?.historyTarget ? "creator_" : "worker_";
      const connection = await lifecycle.opening(launcher, () => runtime.createAcpConnection(workingDirectory, { ...callbacks, tool: async () => { callbackCount++; throw new Error("fixture_execution_forbidden"); } }, available, overrides, signal, profile), phase);
      const actualRequest = connection.request.bind(connection);
      const wrapped = { ...connection, get closed() { return connection.closed; }, mcpServer: proxy.pointAt(connection.mcpServer), close: async () => {
        await lifecycle.observe(phase + "transport_close_before");
        try { await connection.close(); } finally { await lifecycle.observe(phase + "transport_close_after"); }
        if (profile?.historyTarget && profileBytes.empty === undefined) measure("empty", data);
      }, request: async (method, params, settings) => {
        if (!profile?.historyTarget && ["session/new", "session/resume"].includes(method)) requestAppend = params?._meta?.antigravity?.systemPrompt?.append;
        if (!profile?.historyTarget && method === "session/prompt") livePrompts.push(structuredClone(params.prompt));
        const observed = ["session/new", "session/resume", "session/close"].includes(method);
        if (observed) await lifecycle.observe(phase + method + "_before");
        let result;
        try { result = await actualRequest(method, params, settings); }
        catch (error) { if (!cleaning) recordError(phase + method, error, data); throw error; }
        finally { if (observed) await lifecycle.observe(phase + method + "_after"); }
        if (["session/new", "session/resume"].includes(method)) {
          if (typeof result.sessionId === "string") sessionIds.add(result.sessionId);
          if (profile?.historyTarget && method === "session/new" && /^[0-9a-f-]{36}$/i.test(result.sessionId ?? "")) {
            createdSessionId = result.sessionId;
            databasePath = join(data, "conversations", createdSessionId + ".db");
          }
          const selector = result.configOptions?.find(option => option.category === "model" || option.id === "model");
          if (typeof selector?.currentValue === "string") model.id = selector.currentValue;
          if (method === "session/resume") {
            if (!createdSessionId || params.sessionId !== createdSessionId || result.sessionId !== createdSessionId) throw new Error("imported_session_identity");
            imported = true;
          }
        }
        return result;
      } };
      connections.push(wrapped);
      return wrapped;
    } });
    const projection = projectFailedAssistants(context.messages);
    omittedFailedAssistants = projection.omitted;
    const messages = projection.messages.filter(message => message.role !== "system");
    let historyBoundary = messages.length;
    while (historyBoundary > 0 && messages[historyBoundary - 1].role === "user") historyBoundary--;
    const live = livePromptOracle(messages, historyBoundary);
    const promptTextBytes = live.blocks.reduce((sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0), 0);
    const window = historyWindowOracle(messages.slice(0, historyBoundary), promptTextBytes);
    const expected = [...window.expected, ...live.liveExpected];
    omittedEmptyAssistants = window.omittedEmptyAssistants;
    expectedHistoryLosses = window.losses;
    proactiveTrimming = { expected: Number(window.omittedMessages > 0 || window.intraOmittedMessages > 0), verified: 0,
      wholeTurn: { messages: window.omittedMessages, targetBytes: window.omittedTargetBytes, markerNetBytes: window.markerNetBytes },
      intraTurn: { messages: window.intraOmittedMessages, targetBytes: window.intraOmittedTargetBytes, markerNetBytes: window.intraMarkerNetBytes } };
    sourceUserCount = live.sourceUserCount; liveUserCoalescing = live.coalescing; liveSeparatorBytes = live.separatorBytes;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
    let result;
    try { result = await bridge.streamSimple(model, context, { env, signal: controller.signal, timeoutMs: 20000 }).result(); }
    finally { clearTimeout(timer); }
    if (profileRoot && imported) measure("completed", profileRoot);
    if (["error", "aborted", "toolUse"].includes(result.stopReason)) {
      differences.add("native_result");
      recordError("stream_result", { name: "Error", message: result.errorMessage }, profileRoot);
      if (result.errorMessage === "Antigravity cannot import this history. Compact with another model or start a new conversation.") differences.add(window.rejectedAdmission ?? admissionReason(messages.slice(0, historyBoundary)));
      if (result.errorMessage === "Antigravity cannot fit the latest turn. Compact with another model or start a new conversation.") differences.add("history_budget_exceeded");
      if (result.errorMessage === "Antigravity input exceeds 185 KB. Shorten the message or use another model.") differences.add("live_prompt_budget_exceeded");
    }
    if (!imported) differences.add("history_not_imported");
    if (window.promptExceeded && (requests.length || livePrompts.length || result.stopReason === "stop")) differences.add("live_prompt_budget_bypassed");
    if ((imported || requests.length) && window.rejectedAdmission) differences.add("source_admission_bypassed");
    if ((imported || requests.length) && window.budgetExceeded) differences.add("history_budget_bypassed");
    let framing;
    if (imported && databasePath) {
      try { framing = readNativeFraming(databasePath); nativeLiveStepCount = framing.users.filter(user => user.liveDetails).length; } catch { differences.add("native_framing_unverified"); }
    }
    if (diagnosticsEnabled && requests.length) {
      writeFileSync(join(root, "synthetic-comparison.json"), JSON.stringify({ sourceMessages: messages, sourceSystem: system, sourceSystemPrompt: systemPrompt, sourceToolNames: toolNames, requestAppend, sourceLivePrompt: live.blocks, livePrompts, proactiveTrimming, expected, requests, framing }), { mode: 0o600, flag: "wx" });
      syntheticArtifact = 1;
    }
    if (requests.length !== 1) differences.add("main_request_count");
    else {
      if (livePrompts.length !== 1 || !isDeepStrictEqual(live.blocks, livePrompts[0])) differences.add("live_prompt_blocks");
      if (nativeLiveStepCount !== 1) differences.add("native_live_step_count");
      try {
        const comparison = compareSystem(system, systemPrompt, toolNames, requestAppend, requests[0]);
        for (const kind of comparison.differences) differences.add(kind);
        systemVerified = comparison.verified; systemToolReferenceMappings = comparison.toolReferenceMappings;
      } catch { differences.add("system_comparison_unverified"); }
      try {
        const actual = decodeRequest(requests[0], framing);
        const comparison = compareHistory(expected, actual);
        if (diagnosticsEnabled && comparison.differences.length) comparisonDiagnostics = diagnoseComparison(expected, actual);
        for (const kind of comparison.differences) differences.add(kind);
        truncations = comparison.truncations;
        knownDifferences = comparison.knownDifferences;
        proactiveTrimming.verified = Number(proactiveTrimming.expected && !comparison.differences.length
          && !window.rejectedAdmission && !window.budgetExceeded && !window.promptExceeded);
        if (comparison.differences.length) comparisonSummary = anonymousComparison(expected, actual, requests[0], framing);
      } catch (error) {
        const known = ["request_shape", "mixed_result_shape", "result_shape", "result_text_shape", "result_error_shape", "request_part_shape", "user_frame_unverified", "native_notice_position"];
        differences.add(known.includes(error.message) ? error.message : "request_shape_unverified");
      }
    }
  } catch (error) { recordError("native_setup", error, profileRoot); differences.add("native_setup"); }
  finally {
    cleaning = true;
    if (JSON.stringify(input) !== original) differences.add("source_memory_changed");
    if (callbackCount) differences.add("fixture_tool_execution");
    for (const connection of connections) {
      if (!connection.closed) for (const sessionId of sessionIds) {
        try { await connection.request("session/close", { sessionId }, { timeoutMs: 2000 }); } catch { cleanup.closeFailures++; }
      }
      try { await connection.close(); } catch { cleanup.closeFailures++; }
    }
    bridge?.reset();
    await lifecycle.observe("final");
    if (nativeAttempted) { cleanup.retainedCaseRoots = 1; cleanup.unprovenWorkers = 1; }
    // The authorized localhost policy is not a strong proxy/port-identity
    // boundary. Retention is informational; never delete an unproven profile.
    if (backend) await stopServer(backend);
    if (proxy) await proxy.close();
    if (!nativeAttempted && !cleanupRoot(root, false)) cleanup.retainedCaseRoots = 1;
    if (synthetic) {
      try {
        if (!neighborBefore || !neighbor?.sessionId || !createdSessionId || neighbor.sessionId === createdSessionId) throw new Error("synthetic_neighbor_unverified");
        sharedProfileVerification.neighborDatabaseAndSummaryUnchanged = Number(isDeepStrictEqual(neighborBefore, syntheticSessionSnapshot(profileRoot, neighbor.sessionId, root)));
        syntheticSessionSnapshot(profileRoot, createdSessionId, root);
        sharedProfileVerification.importedSummaryPresent = 1;
        sharedProfileVerification.verified = Number(sharedProfileVerification.zeroPromptRoundtrip && sharedProfileVerification.neighborDatabaseAndSummaryUnchanged);
      } catch { /* No unverified index layout may pass the prerequisite. */ }
      if (!sharedProfileVerification.verified) differences.add("shared_profile_unverified");
    }
    if (profileRoot) {
      try {
        if (lstatSync(profileRoot).isDirectory()) { cleanup.retainedProfiles = 1; measure("afterClose", profileRoot); }
      } catch (error) { if (error.code !== "ENOENT") differences.add("profile_size_unavailable"); }
    }
  }
  const lossReporting = compareImportLossReports(expectedHistoryLosses, importLossReports, livePrompts.length > 0);
  for (const kind of lossReporting.differences) differences.add(kind);
  const historyLossReporting = { expectedReports: lossReporting.expectedReports, actualReports: lossReporting.actualReports,
    verifiedReports: lossReporting.verifiedReports };
  return { differences: [...differences], truncations, knownDifferences, expectedHistoryLosses, historyLossReporting, proactiveTrimming, sharedProfileVerification, ...(comparisonSummary ? { comparisonSummary } : {}), callbackCount, imported: Number(imported), sourceVisibleBytes: visibleBytes(input), historyVisibleBytes: visibleBytes(historyInput), sourceSystemMessages: input.length - historyInput.length, systemBytes, hasSystem, systemVerified, systemToolReferenceMappings, recordedToolDeclarations, sourceUserCount, nativeLiveStepCount, liveUserCoalescing, liveSeparatorBytes, omittedFailedAssistants, omittedEmptyAssistants, profileBytes, lifecycle: lifecycle.summary(), cleanup, ...(diagnosticsEnabled ? { syntheticRoot: root, syntheticArtifact, ...(comparisonDiagnostics ? { comparisonDiagnostics } : {}), ...(firstError ? { firstError } : {}) } : {}) };
}

async function runNative(real, adjacentUsers = false, emptyAssistants = false) {
  // This must precede even enumerating the real session directory.
  const protectedRoots = protectedProfileRoots();
  await verifyIsolation();
  const sourceRoot = join(homedir(), ".local/state/pi/sessions");
  const runtime = await loadRuntime();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, cleanEnvironment("/tmp"));
  process.umask(0o077);
  const runRoot = real ? realpathSync(mkdtempSync(join(tmpdir(), "pi-history-regression-run-"))) : undefined;
  const smokeUnicode = "\uE000\uF8FE\uF8FF\uF8FF\u200C\u200D\u200E";
  const smoke = [
    { role: "system", content: "Local codec regression. Do not call tools.", sections: { tools: "- regression_fixture: execution is forbidden.", rules: "Do not call `regression_fixture`.", custom: "SYNTHETIC_SYSTEM_SECTION keeps `regression_fixture` unchanged." }, toolsAdded: [{ name: "regression_fixture", description: "Synthetic fixture. Execution is forbidden.", parameters: { type: "object", additionalProperties: true } }], timestamp: 0 },
    { role: "user", content: "SYNTHETIC_OLD_USER", timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "SYNTHETIC_OLD_ASSISTANT" + "x".repeat(400000) }], stopReason: "stop", timestamp: 0 },
    { role: "user", content: "SYNTHETIC_HISTORY_USER" + smokeUnicode + "x".repeat(190000) + "\uF900\u200A\u2010", timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id: "failed-call", name: "regression_fixture", arguments: {} }], stopReason: "error", errorMessage: "synthetic", timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "SYNTHETIC_ABORTED_NOT_REPLAYED" }], stopReason: "aborted", timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "SYNTHETIC_INTERMEDIATE_ASSISTANT" + "x".repeat(350000) }, { type: "toolCall", id: "intermediate-call", name: "regression_fixture", arguments: { drop: true } }], stopReason: "toolUse", timestamp: 0 },
    { role: "toolResult", toolCallId: "intermediate-call", toolName: "regression_fixture", isError: false, content: [{ type: "text", text: "SYNTHETIC_INTERMEDIATE_RECEIPT" }], timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", id: "synthetic-call", name: "regression_fixture", arguments: { value: "synthetic" } }], stopReason: "toolUse", timestamp: 0 },
    { role: "toolResult", toolCallId: "synthetic-call", toolName: "regression_fixture", isError: false, content: [{ type: "text", text: "SYNTHETIC_RECEIPT" + smokeUnicode }], timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "SYNTHETIC_HISTORY_ASSISTANT" + smokeUnicode }], stopReason: "stop", timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "SYNTHETIC_LIVE_A" }, { type: "text", text: "_B" }], timestamp: 0 },
    { role: "user", content: "SYNTHETIC_LIVE_C", timestamp: 0 },
  ];
  const adjacentSmoke = [smoke[0],
    ...["A", "B", "C"].map(value => ({ role: "user", content: `SYNTHETIC_HISTORY_${value}`, timestamp: 0 })),
    { role: "assistant", content: [{ type: "toolCall", id: "adjacent-call", name: "regression_fixture", arguments: { n: 1 } }], stopReason: "toolUse", timestamp: 0 },
    { role: "toolResult", toolCallId: "adjacent-call", toolName: "regression_fixture", isError: false, content: [{ type: "text", text: "SYNTHETIC_RECEIPT" }], timestamp: 0 },
    { role: "user", content: "SYNTHETIC_CURRENT", timestamp: 0 },
  ];
  const emptyAssistant = () => ({ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop", timestamp: 0 });
  const emptySmoke = [...adjacentSmoke.slice(0, 2), emptyAssistant(), ...adjacentSmoke.slice(2, 6), emptyAssistant(), adjacentSmoke.at(-1)];
  const proof = await nativeCase(runtime, emptyAssistants ? emptySmoke : adjacentUsers ? adjacentSmoke : smoke, true, runRoot, protectedRoots);
  if (!real) return { syntheticVariant: emptyAssistants ? "empty_assistants" : adjacentUsers ? "adjacent_users" : "combined", fixtureToolset: 1, cases: 1, passed: Number(!proof.differences.length), ...proof };
  if (proof.differences.length) return { runRoot, fixtureToolset: 1, requested: 30, selected: 0, processed: 0, passed: 0, prerequisiteSmokeFailed: 1,
    differences: Object.fromEntries(proof.differences.map(kind => [kind, 1])), cleanup: proof.cleanup };
  const counts = { runRoot, comparisonScope: "recorded_system_and_history", fullModelContextCompared: 0, recordedToolset: 1, liveToolAvailabilityChecked: 0, loopbackProxyRisk: 1, historyWindowPolicy: { revision: 4, maxBytes: 500000 }, proactiveTrimming: { expectedCases: 0, verifiedCases: 0,
    wholeTurn: { expectedCases: 0, verifiedCases: 0, expectedMessages: 0, expectedTargetBytes: 0, expectedMarkerNetBytes: 0 },
    intraTurn: { expectedCases: 0, verifiedCases: 0, expectedMessages: 0, expectedTargetBytes: 0, expectedMarkerNetBytes: 0 } }, requested: 30, scanned: 0, invalid: 0, selected: 0, processed: 0, passed: 0, imported: 0, callbackCount: 0, truncations: 0, externalAppends: 0, appendedBytes: 0, sourceSystemMessages: 0, hasSystem: 0, systemVerified: 0, systemToolReferenceMappings: 0, recordedToolDeclarations: 0, sourceUserCount: 0, nativeLiveStepCount: 0, liveUserCoalescing: 0, liveSeparatorBytes: 0, omittedFailedAssistants: { error: 0, aborted: 0 }, omittedEmptyAssistants: 0,
    expectedHistoryLosses: { userTruncated: 0, toolResultsTruncated: 0, earlierMessagesOmitted: 0, intermediateMessagesOmitted: 0, toolImagesOmitted: 0 },
    historyLossReporting: { expectedReports: 0, actualReports: 0, verifiedReports: 0 },
    retainedProfiles: proof.cleanup.retainedProfiles, retainedCaseRoots: proof.cleanup.retainedCaseRoots, unprovenWorkers: proof.cleanup.unprovenWorkers, closeFailures: proof.cleanup.closeFailures, knownDifferenceCases: 0, knownDifferences: {},
    prerequisiteSmoke: { passed: 1, sharedProfileVerification: proof.sharedProfileVerification, expectedHistoryLosses: proof.expectedHistoryLosses, historyLossReporting: proof.historyLossReporting, proactiveTrimming: proof.proactiveTrimming, systemVerified: proof.systemVerified, knownDifferences: proof.knownDifferences, omittedFailedAssistants: proof.omittedFailedAssistants, omittedEmptyAssistants: proof.omittedEmptyAssistants, sourceUserCount: proof.sourceUserCount, nativeLiveStepCount: proof.nativeLiveStepCount, liveUserCoalescing: proof.liveUserCoalescing, liveSeparatorBytes: proof.liveSeparatorBytes, retainedProfiles: proof.cleanup.retainedProfiles, nativeBytesAfterClose: proof.profileBytes.afterClose ?? null }, differences: {} };
  const sizes = { sourceVisible: [], historyVisible: [], system: [], empty: [], beforeResume: [], completed: [], afterClose: [] };
  const caseResults = [];
  for (const [index, sample] of selectSessions(sourceRoot, runtime, counts).entries()) {
    counts.processed++;
    if (sourceStatus(sample).changed) {
      counts.differences.source_changed = (counts.differences.source_changed ?? 0) + 1;
      caseResults.push({ sampleOrdinal: index + 1, imported: 0, retainedCaseRoot: 0, differences: ["source_changed"] });
      continue;
    }
    const result = await nativeCase(runtime, sample.messages, false, runRoot, protectedRoots);
    const source = sourceStatus(sample);
    if (source.changed) result.differences.push("source_changed");
    else if (source.appendedBytes) { counts.externalAppends++; counts.appendedBytes += source.appendedBytes; }
    counts.passed += Number(!result.differences.length);
    counts.imported += result.imported;
    counts.callbackCount += result.callbackCount;
    counts.truncations += result.truncations;
    counts.omittedEmptyAssistants += result.omittedEmptyAssistants;
    for (const key of Object.keys(counts.expectedHistoryLosses)) counts.expectedHistoryLosses[key] += result.expectedHistoryLosses[key];
    for (const key of Object.keys(counts.historyLossReporting)) counts.historyLossReporting[key] += result.historyLossReporting[key];
    counts.proactiveTrimming.expectedCases += result.proactiveTrimming.expected;
    counts.proactiveTrimming.verifiedCases += result.proactiveTrimming.verified;
    for (const kind of ["wholeTurn", "intraTurn"]) {
      const source = result.proactiveTrimming[kind], total = counts.proactiveTrimming[kind];
      total.expectedCases += Number(source.messages > 0);
      total.verifiedCases += Number(source.messages > 0 && result.proactiveTrimming.verified);
      total.expectedMessages += source.messages;
      total.expectedTargetBytes += source.targetBytes;
      total.expectedMarkerNetBytes += source.markerNetBytes;
    }
    counts.knownDifferenceCases += Number(Object.keys(result.knownDifferences).length > 0);
    for (const [kind, values] of Object.entries(result.knownDifferences)) {
      const total = counts.knownDifferences[kind] ??= { texts: 0, characters: 0, bytes: 0 };
      for (const key of ["texts", "characters", "bytes"]) total[key] += values[key];
    }
    counts.retainedProfiles += result.cleanup.retainedProfiles;
    counts.retainedCaseRoots += result.cleanup.retainedCaseRoots;
    counts.unprovenWorkers += result.cleanup.unprovenWorkers;
    counts.closeFailures += result.cleanup.closeFailures;
    for (const key of ["sourceSystemMessages", "hasSystem", "systemVerified", "systemToolReferenceMappings", "recordedToolDeclarations", "sourceUserCount", "nativeLiveStepCount", "liveUserCoalescing", "liveSeparatorBytes"]) counts[key] += result[key];
    for (const key of ["error", "aborted"]) counts.omittedFailedAssistants[key] += result.omittedFailedAssistants[key];
    sizes.system.push(result.systemBytes);
    sizes.sourceVisible.push(result.sourceVisibleBytes);
    sizes.historyVisible.push(result.historyVisibleBytes);
    for (const stage of ["empty", "beforeResume", "completed", "afterClose"]) {
      if (result.profileBytes[stage] !== undefined) sizes[stage].push(result.profileBytes[stage]);
    }
    for (const kind of result.differences) counts.differences[kind] = (counts.differences[kind] ?? 0) + 1;
    caseResults.push({ sampleOrdinal: index + 1, imported: result.imported, systemVerified: result.systemVerified, retainedCaseRoot: result.cleanup.retainedCaseRoots, differences: result.differences, knownDifferences: result.knownDifferences, expectedHistoryLosses: result.expectedHistoryLosses, historyLossReporting: result.historyLossReporting, proactiveTrimming: result.proactiveTrimming,
      ...(result.comparisonSummary ? { comparisonSummary: result.comparisonSummary } : {}), omittedFailedAssistants: result.omittedFailedAssistants, omittedEmptyAssistants: result.omittedEmptyAssistants,
      sourceUserCount: result.sourceUserCount, nativeLiveStepCount: result.nativeLiveStepCount, liveUserCoalescing: result.liveUserCoalescing, liveSeparatorBytes: result.liveSeparatorBytes, recordedToolDeclarations: result.recordedToolDeclarations });
  }
  writeFileSync(join(runRoot, "case-results.json"), JSON.stringify(caseResults), { mode: 0o600, flag: "wx" });
  counts.passRatio = counts.selected ? counts.passed / counts.selected : 0;
  counts.bytes = Object.fromEntries(Object.entries(sizes).map(([stage, values]) => [stage, distribution(values)]));
  counts.rejected = counts.processed - counts.imported;
  counts.failed = counts.processed - counts.passed;
  counts.retainedNativeBytes = (proof.profileBytes.afterClose ?? 0) + (counts.bytes.afterClose.total ?? 0);
  return counts;
}

module.exports = { digest, parseEntries, visibleBytes, selectSessions, sourceStatus, requestMessages, expectedHistory, approvedText, compareHistory, networkProfile, cleanEnvironment, verifyIsolation, mcpProxy, lifecycleObserver, decodeRequest, diagnoseComparison, anonymousComparison, readNativeFraming, admissionReason, compareSystem, validSystemSources, approvedUserText, projectFailedAssistants, livePromptOracle, projectedText, historyWindowOracle, omittableEmptyAssistant, loadRuntime, protectedProfileRoots, assertSyntheticReadPaths };

if (require.main === module) {
  void (async () => {
    if (process.argv.length === 3 && process.argv[2] === "--self-test") return { selfTests: selfTest() + revision2SelfTest() + anonymousComparisonSelfTest() + importLossReportSelfTest(), failed: 0 };
    if (process.argv.length === 3 && process.argv[2] === "--verify-isolation") return verifyIsolation();
    if (process.argv.length === 3 && process.argv[2] === "--inspect-admission") return inspectAdmission();
    if (process.argv.length === 3 && process.argv[2] === "--verify-default-profile") {
      const result = await verifyDefaultProfile();
      if (!result.passed) process.exitCode = 1;
      return result;
    }
    if (process.argv[2] === "--native-smoke" && (process.argv.length === 3
      || (process.argv.length === 4 && ["--adjacent-users", "--empty-assistants"].includes(process.argv[3])))) {
      const result = await runNative(false, process.argv[3] === "--adjacent-users", process.argv[3] === "--empty-assistants");
      if (result.differences.length) process.exitCode = 1;
      return result;
    }
    if (process.argv.length === 3 && process.argv[2] === "--run") {
      const result = await runNative(true);
      if (result.runRoot) writeFileSync(join(result.runRoot, "summary.json"), JSON.stringify(result) + "\n", { mode: 0o600, flag: "wx" });
      if (result.selected !== 30 || result.processed !== 30 || result.passed !== 30) process.exitCode = 1;
      return result;
    }
    process.exitCode = 2;
    return { blocked: 1, differences: ["unsupported_mode"] };
  })().then(result => process.stdout.write(JSON.stringify(result) + "\n"), () => {
    // Error objects can contain history, arguments, paths, or credentials.
    process.stdout.write(JSON.stringify({ failed: 1, differences: ["regression_setup"] }) + "\n");
    process.exitCode = 1;
  });
}
