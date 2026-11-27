const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, realpathSync, statSync, symlinkSync, renameSync, linkSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
let prepareHistory, writeHistory, HISTORY_IMPORT_POLICY, formatOmission, boundedToolResultText;
before(async () => ({ prepareHistory, writeHistory, HISTORY_IMPORT_POLICY, formatOmission, boundedToolResultText } = await import("../antigravity/history.ts")));
const prepareSteps = (...args) => prepareHistory(...args)?.steps;
const user = (text) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason, timestamp: 0 });
const text = (text) => ({ type: "text", text });
const png = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" };
const pair = (name = "echo", result = "COMPLETED_中文") => [
  assistant([{ type: "toolCall", id: "original-call", name, arguments: { text: "ARGUMENT_中文" } }], "toolUse"),
  { role: "toolResult", toolCallId: "original-call", toolName: name, isError: false, content: [text(result)], timestamp: 0 },
];

function target(t, constraint = "") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-history-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionId = randomUUID(), trajectoryId = randomUUID();
  const path = join(root, "conversations", sessionId + ".db");
  const imageDirectory = join(root, "brain", sessionId, ".user_uploaded");
  mkdirSync(dirname(path));
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE steps (idx INTEGER PRIMARY KEY ${constraint}, step_type INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL DEFAULT 0, has_subtrajectory NUMERIC NOT NULL DEFAULT false,
      metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB,
      step_payload BLOB, step_format INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE battle_mode_infos (idx INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY DEFAULT 'main', data BLOB);
  `);
  db.prepare("INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)").run(trajectoryId, sessionId);
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(Buffer.from("synthetic-native-metadata"));
  db.close();
  return { root, path, sessionId, trajectoryId, imageDirectory, identity: statSync(path) };
}
function rows(path, table = "steps") {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(`SELECT * FROM ${table}`).all(); } finally { db.close(); }
}
// Independent reader of the two wire types emitted by the writer.
function fields(bytes) {
  const data = Buffer.from(bytes); let p = 0;
  const integer = () => { let n = 0, factor = 1, b; do { b = data[p++]; n += (b & 127) * factor; factor *= 128; } while (b & 128); return n; };
  const result = [];
  while (p < data.length) {
    const key = integer(), wire = key % 8;
    if (wire === 0) result.push([key >> 3, integer()]);
    else { assert.equal(wire, 2); const size = integer(); result.push([key >> 3, data.subarray(p, p + size)]); p += size; }
  }
  return result;
}
function at(bytes, ...path) {
  const value = fields(bytes).find(([number]) => number === path[0])?.[1];
  return path.length === 1 ? value : at(value, ...path.slice(1));
}

test("writes complete visible text into an existing empty native target without changing its identity", (t) => {
  const fixture = target(t);
  const messages = [user('中文 "quoted"\n'), assistant([{ type: "thinking", thinking: "private", thinkingSignature: "opaque" }, { ...text("visible\nanswer"), textSignature: "signed" }])];
  const prepared = prepareSteps(messages);
  assert.ok(prepared);
  const identity = rows(fixture.path, "trajectory_meta");
  const metadata = rows(fixture.path, "trajectory_metadata_blob");
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
  const written = rows(fixture.path);
  assert.deepEqual(written.map(r => [r.idx, r.step_type, r.status]), [[0, 14, 3], [1, 15, 3]]);
  assert.equal(at(written[0].step_payload, 19, 2).toString(), messages[0].content);
  assert.equal(at(written[0].step_payload, 19, 3, 1).toString(), messages[0].content);
  assert.equal(at(written[1].step_payload, 20, 1).toString(), "visible\nanswer");
  assert.equal(at(written[1].step_payload, 20, 8).toString(), "visible\nanswer");
  for (const row of written) {
    assert.deepEqual(Buffer.from(row.metadata), at(row.step_payload, 5));
    assert.equal(at(row.metadata, 20, 1).toString(), fixture.trajectoryId);
    assert.equal(at(row.metadata, 20, 2), row.idx);
    assert.equal(at(row.metadata, 20, 4).toString(), fixture.sessionId);
    for (const omitted of ["private", "opaque", "signed"]) assert.equal(Buffer.from(row.step_payload).includes(Buffer.from(omitted)), false);
  }
  assert.deepEqual(rows(fixture.path, "trajectory_meta"), identity);
  assert.deepEqual(rows(fixture.path, "trajectory_metadata_blob"), metadata);
  assert.deepEqual(rows(fixture.path, "gen_metadata"), []);
});

test("writes one completed text tool pair with fresh shared identity and exact Pi namespacing", (t) => {
  for (const name of ["echo", "mcp_pi_echo"]) {
    const fixture = target(t);
    const input = [user("中文\n".repeat(24000)), assistant([text("before")]), ...pair(name, "receipt中文\n".repeat(2200)), assistant([text("after")])];
    const before = structuredClone(input);
    const prepared = prepareSteps(input);
    assert.ok(prepared);
    assert.deepEqual(input, before);
    assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
    const written = rows(fixture.path);
    assert.deepEqual(written.map(r => r.step_type), [14, 15, 15, 132, 15]);
    assert.equal(at(written[0].step_payload, 19, 2).toString(), input[0].content);
    assert.equal(at(written[1].step_payload, 20, 1).toString(), "before");
    assert.equal(at(written[4].step_payload, 20, 1).toString(), "after");
    const callId = at(written[2].step_payload, 20, 7, 1).toString();
    assert.match(callId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    assert.notEqual(callId, "original-call");
    assert.equal(at(written[3].metadata, 4, 1).toString(), callId);
    for (const tuple of [at(written[2].step_payload, 20, 7), at(written[3].metadata, 4)]) {
      assert.equal(at(tuple, 2).toString(), "mcp_pi_" + name);
      assert.deepEqual(JSON.parse(at(tuple, 3).toString()), { text: "ARGUMENT_中文" });
    }
    assert.equal(at(written[3].step_payload, 133, 2, 1, 2).toString(), "pi/" + name);
    assert.equal(at(written[3].step_payload, 140, 1, 1).toString(), "text");
    assert.equal(at(written[3].step_payload, 140, 1, 2).toString(), "ARGUMENT_中文");
    assert.equal(at(written[3].step_payload, 140, 2, 1).toString(), input[3].content[0].text);
    assert.equal(written.every(row => row.status === 3 && row.has_subtrajectory === 0), true);
    assert.ok(Buffer.byteLength(input[0].content) + Buffer.byteLength(input[3].content[0].text) > 185000);
    const other = target(t);
    assert.equal(writeHistory(other.path, other.sessionId, prepareSteps(input), undefined, other.identity), true);
    assert.notEqual(at(rows(other.path)[2].step_payload, 20, 7, 1).toString(), callId);
  }
});

test("encodes observed JSON arguments and two sequential pairs without losing value types", (t) => {
  const fixture = target(t);
  const args = { text: "JSON_ARGUMENT_中文", count: 7.5, flag: false, empty: null, items: ["x", 2, true, null, { inner: "中" }], nested: { a: 1, b: { ok: true } }, toolSummary: "Synthetic mixed JSON echo" };
  const first = pair();
  first[0].content[0].arguments = args;
  const second = pair("echo", "SECOND_RESULT_中文");
  second[0].content[0].id = second[1].toolCallId = "second-source-call";
  const prepared = prepareSteps([user("start"), ...first, ...second, assistant([text("done")])]);
  assert.ok(prepared);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
  const written = rows(fixture.path);
  assert.deepEqual(written.map(r => r.step_type), [14, 15, 132, 15, 132, 15]);
  assert.deepEqual(JSON.parse(at(written[1].step_payload, 20, 7, 3).toString()), args);
  const entries = Object.fromEntries(fields(at(written[2].step_payload, 140)).filter(([number]) => number === 1).map(([, value]) => [at(value, 1).toString(), at(value, 2).toString()]));
  // Literal representations observed in native 1.5.15 payload140->1.
  assert.deepEqual(entries, { text: "JSON_ARGUMENT_中文", count: "7.5", flag: "false", empty: "", items: '["x",2,true,null,{"inner":"中"}]', nested: '{"a":1,"b":{"ok":true}}', toolSummary: "Synthetic mixed JSON echo" });
  const ids = [1, 3].map(index => at(written[index].step_payload, 20, 7, 1).toString());
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids.some(id => ["original-call", "second-source-call"].includes(id)), false);
  assert.equal(at(written[2].metadata, 4, 1).toString(), ids[0]);
  assert.equal(at(written[4].metadata, 4, 1).toString(), ids[1]);
  assert.equal(at(written[4].step_payload, 140, 2, 1).toString(), "SECOND_RESULT_中文");
});

test("writes only the proven Text then PNG layout with explicit target resource authority", (t) => {
  const fixture = target(t);
  const attachment = 'EXACT_TEXT_ATTACHMENT_中文\n<file name="note.txt">content</file>\n';
  const prepared = prepareSteps([user([text("caption before image"), png]), assistant([text("seen")]), user([text(attachment)])]);
  assert.ok(prepared);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), false);
  const outside = join(fixture.root, "not-authorized");
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, outside, fixture.identity), false);
  assert.equal(existsSync(outside), false);
  assert.deepEqual(rows(fixture.path), []);
  mkdirSync(fixture.imageDirectory, { recursive: true });
  writeFileSync(join(fixture.imageDirectory, "keep.txt"), "preexisting");
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, fixture.imageDirectory, fixture.identity), true);
  const written = rows(fixture.path);
  assert.deepEqual(written.map(r => r.step_type), [14, 15, 14]);
  assert.equal(at(written[0].step_payload, 19, 2).toString(), "caption before image");
  assert.equal(at(written[0].step_payload, 19, 9, 1).toString(), "image/png");
  assert.deepEqual(at(written[0].step_payload, 19, 9, 2), Buffer.from(png.data, "base64"));
  const imagePath = at(written[0].step_payload, 19, 9, 5).toString();
  assert.equal(dirname(imagePath), fixture.imageDirectory);
  assert.deepEqual(readFileSync(imagePath), Buffer.from(png.data, "base64"));
  assert.equal(at(written[2].step_payload, 19, 2).toString(), attachment);
  assert.equal(readFileSync(join(fixture.imageDirectory, "keep.txt"), "utf8"), "preexisting");
  assert.equal(readdirSync(fixture.imageDirectory).length, 2);
});

test("writes multiple text blocks using the native MCP newline separator", (t) => {
  const input = pair();
  input[1].content = [text("BLOCK_A_甲\nEND_A"), text("BLOCK_B_乙\nEND_B"), text("BLOCK_C_丙\nEND_C")];
  const before = structuredClone(input);
  const prepared = prepareSteps(input);
  assert.ok(prepared);
  const fixture = target(t);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
  assert.equal(at(rows(fixture.path)[1].step_payload, 140, 2, 1).toString(), "BLOCK_A_甲\nEND_A\nBLOCK_B_乙\nEND_B\nBLOCK_C_丙\nEND_C");
  assert.deepEqual(input, before);
});

test("writes failed MCP results with native error status and matching error details", (t) => {
  const input = pair("echo", "SYNTHETIC_FAILURE_错误_SENTINEL");
  input[1].isError = true;
  const before = structuredClone(input);
  const prepared = prepareSteps(input);
  assert.ok(prepared);
  const fixture = target(t);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
  const result = rows(fixture.path)[1];
  assert.equal(result.status, 7);
  assert.equal(at(result.step_payload, 4), 7);
  assert.deepEqual(Buffer.from(result.error_details), at(result.step_payload, 31));
  assert.equal(at(result.error_details, 2).toString(), "SYNTHETIC_FAILURE_错误_SENTINEL");
  assert.equal(at(result.error_details, 3).toString(), "SYNTHETIC_FAILURE_错误_SENTINEL");
  assert.equal(at(result.step_payload, 140, 2, 1), undefined);
  assert.deepEqual(input, before);
});

test("keeps assistant text and its call in one native planner step", (t) => {
  const input = pair();
  input[0].content.unshift(text("ASSISTANT_BEFORE_CALL_甲_SENTINEL"));
  const before = structuredClone(input);
  const prepared = prepareSteps(input);
  assert.ok(prepared);
  const fixture = target(t);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
  const written = rows(fixture.path);
  assert.deepEqual(written.map(row => row.step_type), [15, 132]);
  assert.equal(at(written[0].step_payload, 20, 1).toString(), "ASSISTANT_BEFORE_CALL_甲_SENTINEL");
  assert.equal(at(written[0].step_payload, 20, 8).toString(), "ASSISTANT_BEFORE_CALL_甲_SENTINEL");
  assert.equal(at(written[0].step_payload, 20, 7, 1).toString(), at(written[1].metadata, 4, 1).toString());
  assert.deepEqual(input, before);
});

test("keeps a parallel tool batch grouped with results normalized to call order", (t) => {
  const first = pair(), second = pair("echo", "SECOND_RESULT_中文");
  first[0].content[0].arguments = { slot: "one" };
  second[0].content[0].arguments = { slot: "two" };
  second[0].content[0].id = second[1].toolCallId = "second-source-call";
  const group = assistant([text("GROUP_LEADING_乙"), first[0].content[0], second[0].content[0]], "toolUse");
  const input = [group, second[1], first[1]], before = structuredClone(input);
  const prepared = prepareSteps(input);
  assert.ok(prepared);
  const fixture = target(t);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
  const written = rows(fixture.path);
  assert.deepEqual(written.map(row => row.step_type), [15, 132, 132]);
  const calls = fields(at(written[0].step_payload, 20)).filter(([number]) => number === 7).map(([, value]) => value);
  assert.deepEqual(calls.map(call => JSON.parse(at(call, 3).toString())), [{ slot: "one" }, { slot: "two" }]);
  const ids = calls.map(call => at(call, 1).toString());
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids.some(id => ["original-call", "second-source-call"].includes(id)), false);
  assert.equal(at(written[0].step_payload, 20, 1).toString(), "GROUP_LEADING_乙");
  assert.equal(at(written[0].step_payload, 20, 8).toString(), "GROUP_LEADING_乙");
  assert.equal(at(written[1].metadata, 4, 1).toString(), ids[0]);
  assert.equal(at(written[2].metadata, 4, 1).toString(), ids[1]);
  assert.equal(at(written[1].step_payload, 140, 2, 1).toString(), "COMPLETED_中文");
  assert.equal(at(written[2].step_payload, 140, 2, 1).toString(), "SECOND_RESULT_中文");
  assert.deepEqual(input, before);
  for (const results of [[first[1]], [first[1], first[1]], [first[1], user("gap"), second[1]]]) {
    assert.equal(prepareSteps([group, ...results]), undefined);
  }
});

test("replaces tool-result images with explicit text placeholders without image files", (t) => {
  const input = pair();
  input[1].content = [text("IMAGE_BEFORE"), png, text("IMAGE_AFTER"), png];
  const before = structuredClone(input);
  const prepared = prepareSteps(input);
  assert.ok(prepared);
  const fixture = target(t);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
  const result = rows(fixture.path)[1];
  assert.equal(at(result.step_payload, 140, 2, 1).toString(), "IMAGE_BEFORE\n[Pi omitted an image]\nIMAGE_AFTER\n[Pi omitted an image]");
  assert.equal(at(result.step_payload, 140, 2, 4), undefined);
  assert.equal(existsSync(fixture.imageDirectory), false);
  assert.deepEqual(input, before);
});

test("imports retired tool names while validating call names and IDs", (t) => {
  const input = pair("retired_tool"), before = structuredClone(input);
  const prepared = prepareSteps(input);
  assert.ok(prepared);
  const fixture = target(t);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
  const written = rows(fixture.path);
  assert.equal(at(written[0].step_payload, 20, 7, 2).toString(), "mcp_pi_retired_tool");
  assert.equal(at(written[1].metadata, 4, 2).toString(), "mcp_pi_retired_tool");
  assert.deepEqual(input, before);
  for (const name of ["", 42, "\ud800"]) assert.equal(prepareSteps(pair(name)), undefined);
  for (const id of ["", 42]) {
    const invalid = pair();
    invalid[0].content[0].id = invalid[1].toolCallId = id;
    assert.equal(prepareSteps(invalid), undefined);
  }
});

test("rejects the entire history for unsupported visible layouts, states, arguments or pairings", () => {
  let deepArguments = { text: "leaf" };
  for (let i = 0; i < 6000; i++) deepArguments = { nested: deepArguments };
  const invalid = [
    [user([{ type: "image", mimeType: "image/png", data: "AA==" }])],
    [user([text("before"), png, text("after")])],
    [user([text("caption"), { ...png, data: "not base64" }])],
    [assistant([pair()[0].content[0], text("after")], "toolUse"), pair()[1]],
    [pair()[0]],
    [pair()[0], { ...pair()[1], isError: undefined }],
    [...pair(), ...pair()],
    [assistant([text("partial")], "pending")],
    [{ ...assistant([text("deferred")]), deferred: { id: "token" } }],
    [assistant([{ ...pair()[0].content[0], arguments: { count: NaN } }], "toolUse"), pair()[1]],
    [assistant([{ ...pair()[0].content[0], arguments: { count: -0 } }], "toolUse"), pair()[1]],
    [assistant([{ ...pair()[0].content[0], arguments: deepArguments }], "toolUse"), pair()[1]],
    [assistant([{ ...pair()[0].content[0], argumentsError: "invalid JSON" }], "toolUse"), pair()[1]],
    [assistant([{ ...pair()[0].content[0], namespace: "other" }], "toolUse"), pair()[1]],
    pair(""),
  ];
  invalid.forEach((messages, i) => assert.equal(prepareSteps([user("valid prefix"), ...messages]), undefined, `case ${i}`));
  assert.equal(prepareSteps([user([text("a"), text("b")])])[0].text, "ab");
  assert.equal(prepareSteps([]), undefined);
  assert.equal(prepareSteps([assistant([{ type: "thinking", thinking: "hidden" }])]), undefined);
  assert.ok(prepareSteps([user([text("visible")]), assistant([{ type: "thinking", thinking: "hidden" }]), ...pair()]));
});

test("bounds only the target tool result with exact UTF-8 head, omission count and original tail", (t) => {
  const boundary = "中".repeat(16384);
  assert.equal(prepareSteps(pair("echo", boundary))[1].text, boundary);
  assert.equal(prepareSteps(pair("echo", boundary + "!"))[1].text,
    "中".repeat(8187) + "\n\n[Pi omitted 30 bytes]\n\n" + "中".repeat(8187) + "!");
  const footer = "\n\n[896 more lines in file. Use offset=129 to continue.]";
  const input = pair("echo", "😀".repeat(20000) + footer);
  const original = structuredClone(input);
  const prepared = prepareSteps(input);
  assert.ok(prepared);
  const expected = "😀".repeat(6140) + "\n\n[Pi omitted 30936 bytes]\n\n" + "😀".repeat(6126) + footer;
  assert.equal(prepared[1].text, expected);
  assert.equal(Buffer.byteLength(expected), 49147);
  assert.ok(expected.isWellFormed());
  assert.equal(expected.includes("\ufffd"), false);
  assert.equal(80055 - 6140 * 4 - (6126 * 4 + 55), 30936);
  const fixture = target(t);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
  assert.equal(at(rows(fixture.path)[1].step_payload, 140, 2, 1).toString(), expected);
  assert.deepEqual(input, original);
});

test("reserves the native error prefix before clipping to preserve the original tail", (t) => {
  const prefix = "Encountered error in tool execution: ";
  const footer = "\n\n[896 more lines in file. Use offset=129 to continue.]";
  const input = pair("echo", prefix + "😀".repeat(20000) + footer);
  input[1].isError = true;
  const before = structuredClone(input);
  const prepared = prepareSteps(input);
  const expected = prefix + "😀".repeat(6126) + "\n\n[Pi omitted 31008 bytes]\n\n" + "😀".repeat(6122) + footer;
  assert.equal(Buffer.byteLength(prepared[1].text), 49112);
  assert.equal(prepared[1].text, expected);
  assert.equal(Buffer.byteLength(expected), 49112);
  assert.equal(Buffer.byteLength(prefix + expected), 49149);
  const fixture = target(t);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), true);
  assert.equal(at(rows(fixture.path)[1].error_details, 2).toString(), expected);
  assert.equal(at(rows(fixture.path)[1].error_details, 3).toString(), expected);
  assert.deepEqual(input, before);
});

test("splits historical users losslessly while preserving full assistant text", (t) => {
  for (const body of ["x".repeat(185001), "中文".repeat(40000), "😀".repeat(50000) + "\n\nFINAL instruction"]) {
    const input = [user(body)], original = structuredClone(input);
    const prepared = prepareHistory(input);
    assert.equal(prepared.steps.map(step => step.text).join(""), body);
    assert.ok(prepared.steps.every(step => step.role === "user" && Buffer.byteLength(step.text) <= 185000 && step.text.isWellFormed()));
    assert.deepEqual(prepared.losses, { toolResultsTruncated: 0, toolImagesOmitted: 0 });
    const fixture = target(t);
    assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared.steps, undefined, fixture.identity), true);
    assert.equal(rows(fixture.path).map(row => at(row.step_payload, 19, 2).toString()).join(""), body);
    assert.deepEqual(input, original);
  }
  const body = "a".repeat(180000) + "\r\n\r\n" + "中".repeat(4000) + "\n\nEND";
  const prepared = prepareSteps([user(body)]);
  assert.equal(prepared[0].text, "a".repeat(180000) + "\r\n\r\n");
  assert.equal(prepared.map(step => step.text).join(""), body);
  const longAssistant = "乙".repeat(100000);
  assert.equal(prepareSteps([assistant([text(longAssistant)])])[0].text, longAssistant);
  assert.equal(prepareSteps([user("x".repeat(185000))])[0].text.length, 185000);
});

test("preserves more than 500 KB across complete turns and parallel tool batches", (t) => {
  assert.deepEqual(HISTORY_IMPORT_POLICY, { revision: 6 });
  const input = [];
  for (let turn = 0; turn < 3; turn++) {
    const calls = ["one", "two"].map(name => ({ type: "toolCall", id: turn + name, name: "echo", arguments: { value: name.repeat(30000) } }));
    input.push(user("u".repeat(110000)), assistant([text("a".repeat(100000))]), assistant(calls, "toolUse"),
      ...[...calls].reverse().map(call => ({ role: "toolResult", toolCallId: call.id, toolName: "echo", isError: false, content: [text(call.id)], timestamp: 0 })),
      assistant([text("end " + turn)]));
  }
  const original = structuredClone(input), prepared = prepareHistory(input);
  assert.ok(prepared.steps.reduce((sum, step) => sum + Buffer.byteLength(step.text ?? ""), 0) > 500000);
  assert.deepEqual(prepared.steps.map(step => step.role), Array.from({ length: 3 }, () => ["user", "assistant", "call", "result", "result", "assistant"]).flat());
  assert.deepEqual(prepared.losses, { toolResultsTruncated: 0, toolImagesOmitted: 0 });
  const fixture = target(t);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared.steps, undefined, fixture.identity), true);
  const written = rows(fixture.path);
  assert.equal(written.length, input.length);
  for (let turn = 0; turn < 3; turn++) {
    const offset = turn * 6;
    assert.equal(at(written[offset].step_payload, 19, 2).toString(), input[offset].content);
    assert.equal(at(written[offset + 1].step_payload, 20, 1).toString(), input[offset + 1].content[0].text);
    assert.deepEqual(prepared.steps[offset + 2].calls.map(call => call.arguments), input[offset + 2].content.map(call => call.arguments));
    assert.deepEqual(prepared.steps.slice(offset + 3, offset + 5).map(step => step.text), [turn + "one", turn + "two"]);
    assert.equal(at(written[offset + 5].step_payload, 20, 1).toString(), "end " + turn);
  }
  assert.deepEqual(input, original);
});

test("preserves user text above 1 MB in bounded UTF-8 chunks without changing delimiters or tail instructions", (t) => {
  for (const body of ["x".repeat(1100000), ("中文😀\r\n\r\n").repeat(80000) + "FINAL instruction"]) {
    assert.ok(Buffer.byteLength(body) > 1000000);
    const input = [user(body)], original = structuredClone(input), prepared = prepareHistory(input);
    assert.ok(prepared.steps.every(step => step.role === "user" && step.text.isWellFormed() && Buffer.byteLength(step.text) <= 185000));
    assert.equal(prepared.steps.map(step => step.text).join(""), body);
    const fixture = target(t);
    assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared.steps, undefined, fixture.identity), true);
    assert.equal(rows(fixture.path).map(row => at(row.step_payload, 19, 2).toString()).join(""), body);
    assert.deepEqual(input, original);
  }
});

test("shared tool normalization preserves the exact native byte limits and error prefix budget", () => {
  for (const isError of [false, true]) {
    const limit = 48 * 1024 - (isError ? 37 : 0);
    const exact = "x".repeat(limit);
    assert.equal(boundedToolResultText(exact, isError), exact);
    const body = "😀".repeat(20000) + "FINAL";
    const bounded = boundedToolResultText(body, isError);
    assert.ok(Buffer.byteLength(bounded) <= limit);
    assert.ok(bounded.isWellFormed());
    assert.ok(bounded.endsWith("FINAL"));
    const input = pair("echo", body);
    input[1].isError = isError;
    assert.equal(prepareSteps(input)[1].text, bounded);
  }
  assert.throws(() => prepareSteps([user([text("x".repeat(185001)), png])]), /Antigravity prompt is too long/);
});

test("omits validated empty assistant text but preserves whitespace and empty call-leading text", () => {
  const completed = pair();
  completed[0].content.unshift(text(""));
  const input = [user("task"), assistant([text("")]),
    assistant([{ type: "thinking", thinking: "hidden" }]),
    assistant([{ type: "thinking", thinking: "hidden" }, text("")]),
    assistant([text(" \n")]), ...completed];
  const before = structuredClone(input);
  const prepared = prepareSteps(input);
  assert.deepEqual(prepared.map(step => step.role), ["user", "assistant", "call", "result"]);
  assert.equal(prepared[1].text, " \n");
  assert.equal(prepared[2].text, "");
  assert.deepEqual(input, before);
  for (const invalid of [assistant([text("")], "toolUse"), assistant([text("")], "length"),
    { ...assistant([text("")]), errorMessage: "metadata" },
    { ...assistant([text("")]), deferred: { id: "token" } }, assistant([text(""), text("")])]) {
    assert.equal(prepareSteps([user("task"), invalid]), undefined);
  }
  assert.equal(prepareSteps([assistant([text("")])]), undefined);
});

test("formats singular and plural omission markers without changing their units", () => {
  for (const [count, unit, expected] of [
    [1, "byte", "[Pi omitted 1 byte]"], [2, "byte", "[Pi omitted 2 bytes]"],
  ]) assert.equal(formatOmission(count, unit), expected);
});

test("reports exact loss fields without counting literal markers or invisible assistants", () => {
  const literal = "[Pi omitted 1 byte]\n[Pi omitted 1 earlier message]\n[Pi omitted an image]";
  const input = [user(literal), assistant([{ type: "thinking", thinking: "hidden" }]),
    assistant([text("")]), ...pair("echo", literal)];
  const before = structuredClone(input);
  const prepared = prepareHistory(input);
  assert.deepEqual(Object.keys(prepared).sort(), ["losses", "steps"]);
  assert.deepEqual(prepared.losses, { toolResultsTruncated: 0, toolImagesOmitted: 0 });
  assert.equal(prepared.steps[0].text, literal);
  assert.equal(prepared.steps.at(-1).text, literal);
  assert.deepEqual(input, before);
});

test("counts only truncated result messages separately from source image blocks", () => {
  const first = pair(), second = pair();
  second[0].content[0].id = second[1].toolCallId = "second-call";
  first[1].content = [text("a".repeat(60000)), png];
  second[1].content = [png, text("b".repeat(60000))];
  second[1].isError = true;
  const input = [user("x".repeat(185001)), user([text("y".repeat(185000)), png]), ...first, ...second];
  const before = structuredClone(input);
  const prepared = prepareHistory(input);
  assert.deepEqual(prepared.losses, { toolResultsTruncated: 2, toolImagesOmitted: 2 });
  assert.deepEqual(prepared.steps.map(step => step.role), ["user", "user", "image", "call", "result", "call", "result"]);
  assert.ok(Buffer.byteLength(prepared.steps[4].text) <= 49152);
  assert.ok(Buffer.byteLength(prepared.steps[6].text) <= 49115);
  assert.deepEqual(input, before);
});

test("rejects unpaired UTF-16 surrogates instead of silently replacing visible data", () => {
  assert.equal(prepareSteps([user("lone \ud800")]), undefined);
  assert.equal(prepareSteps(pair("echo", "x".repeat(26000) + "\ud800" + "x".repeat(26000))), undefined);
  const malformed = assistant([{ ...pair()[0].content[0], arguments: { nested: { "\ud800": "\udfff" } } }], "toolUse");
  assert.equal(prepareSteps([user("valid prefix"), malformed, pair()[1]]), undefined);
  assert.ok(prepareSteps([user("paired 😀")]));
});

test("refuses missing, nonempty, wrong-identity or incompatible targets without changing files", (t) => {
  const prepared = prepareSteps([user("import")]);
  const fixture = target(t);
  const missing = join(fixture.root, "missing.db");
  assert.equal(writeHistory(missing, fixture.sessionId, prepared, undefined, fixture.identity), false);
  assert.equal(existsSync(missing), false);
  const mutations = [
    () => {},
    db => db.exec("INSERT INTO steps (idx) VALUES (0)"),
    db => db.exec("ALTER TABLE steps ADD COLUMN incompatible TEXT"),
  ];
  for (let i = 0; i < mutations.length; i++) {
    const targetFixture = target(t);
    const db = new DatabaseSync(targetFixture.path); mutations[i](db); db.close();
    const before = readFileSync(targetFixture.path);
    assert.equal(writeHistory(targetFixture.path, i === 0 ? "wrong-session" : targetFixture.sessionId, prepared, undefined, targetFixture.identity), false);
    assert.deepEqual(readFileSync(targetFixture.path), before);
  }
});

test("rejects replaced targets and symlinked database ancestors", (t) => {
  const fixture = target(t);
  const prepared = prepareSteps([user("import")]);
  renameSync(fixture.path, fixture.path + ".original");
  writeFileSync(fixture.path, readFileSync(fixture.path + ".original"));
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepared, undefined, fixture.identity), false);
  const alias = join(fixture.root, "alias");
  symlinkSync(dirname(fixture.path), alias, "dir");
  assert.equal(writeHistory(join(alias, fixture.sessionId + ".db"), fixture.sessionId, prepared, undefined, statSync(fixture.path)), false);
  assert.deepEqual(rows(fixture.path), []);
});

test("rejects a target hard-linked to a neighboring database", (t) => {
  const fixture = target(t);
  const neighbor = join(dirname(fixture.path), "neighbor.db");
  linkSync(fixture.path, neighbor);
  assert.equal(writeHistory(fixture.path, fixture.sessionId, prepareSteps([user("import")]), undefined, fixture.identity), false);
  assert.deepEqual(rows(fixture.path), []);
  assert.deepEqual(rows(neighbor), []);
});

test("rejects symlinks at every image directory level", (t) => {
  for (const level of ["brain", "session", "uploads"]) {
    const fixture = target(t);
    const outside = join(fixture.root, "outside");
    mkdirSync(outside);
    const directory = level === "brain" ? join(fixture.root, "brain")
      : level === "session" ? dirname(fixture.imageDirectory) : fixture.imageDirectory;
    mkdirSync(dirname(directory), { recursive: true });
    symlinkSync(outside, directory, "dir");
    assert.equal(writeHistory(fixture.path, fixture.sessionId, prepareSteps([user([text("one"), png])]), fixture.imageDirectory, fixture.identity), false);
    assert.deepEqual(rows(fixture.path), []);
    assert.deepEqual(readdirSync(outside), []);
  }
});

test("locks before inspecting an incompatible target and does not retry busy writes", (t) => {
  const fixture = target(t);
  const db = new DatabaseSync(fixture.path);
  try {
    db.exec("ALTER TABLE steps ADD COLUMN incompatible TEXT; BEGIN IMMEDIATE");
    assert.throws(() => writeHistory(fixture.path, fixture.sessionId, prepareSteps([user("import")]), undefined, fixture.identity), /locked|busy/i);
    db.exec("ROLLBACK");
    assert.equal(writeHistory(fixture.path, fixture.sessionId, prepareSteps([user("import")]), undefined, fixture.identity), false);
    assert.deepEqual(rows(fixture.path), []);
  } finally { db.close(); }
});

test("rolls back steps and removes only new image files if any insertion fails", (t) => {
  const fixture = target(t, "CHECK (idx <> 2)");
  const identity = rows(fixture.path, "trajectory_meta");
  mkdirSync(fixture.imageDirectory, { recursive: true });
  writeFileSync(join(fixture.imageDirectory, "keep.txt"), "preexisting");
  const prepared = prepareSteps([user([text("one"), png]), assistant([text("two")]), user("three")]);
  assert.ok(prepared);
  assert.throws(() => writeHistory(fixture.path, fixture.sessionId, prepared, fixture.imageDirectory, fixture.identity), /CHECK constraint failed/);
  assert.deepEqual(rows(fixture.path), []);
  assert.deepEqual(rows(fixture.path, "trajectory_meta"), identity);
  assert.deepEqual(readdirSync(fixture.imageDirectory), ["keep.txt"]);
  assert.equal(readFileSync(join(fixture.imageDirectory, "keep.txt"), "utf8"), "preexisting");
});
