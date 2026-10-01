import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { Assistant, payloadFor, piArgs, PiRpc, ProgressReporter, ProgressState } from "../startup.mjs";

function mockPi(handle) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk));
    handle(request, (record) => child.stdout.write(`${JSON.stringify(record)}\n`));
    done();
  } });
  child.kill = () => child.emit("close", null, "SIGKILL");
  return child;
}

const respond = (request, data) => ({ type: "response", id: request.id, command: request.type, success: true, data });

test("payload keeps necessary media and quote fields without duplicating raw messages", () => {
  const message = {
    message_id: 7, date: 1, chat: { id: 123, type: "private" }, from: { id: 1 }, caption: "Read this",
    photo: [{ file_id: "large", width: 1280, height: 960 }, { file_id: "small", width: 320, height: 240 }],
    document: { file_id: "pdf", file_name: "report.pdf", mime_type: "application/pdf", thumbnail: { file_id: "thumbnail" } },
    voice: { file_id: "voice", duration: 4 },
    reply_to_message: { message_id: 6, text: "Previous file", document: { file_id: "quoted" }, reply_to_message: { message_id: 5 } },
  };
  assert.deepEqual(payloadFor(message), {
    channel: "telegram", chat_id: 123, message_id: 7, text: "Read this",
    attachments: [
      { type: "photo", file_id: "large", width: 1280, height: 960 },
      { type: "document", file_id: "pdf", file_name: "report.pdf", mime_type: "application/pdf" },
      { type: "voice", file_id: "voice", duration: 4 },
    ],
    reply_to: { message_id: 6, text: "Previous file", attachments: [{ type: "document", file_id: "quoted" }] },
  });
});

test("RPC accepts split records, CRLF and Unicode separators inside text", async () => {
  let lastRequest;
  const child = mockPi((request) => { lastRequest = request; });
  const pi = new PiRpc(child);
  const result = pi.command("get_state");
  const line = JSON.stringify(respond(lastRequest, { name: "a\u2028b\u2029c" }));
  child.stdout.write(line.slice(0, 20));
  child.stdout.write(`${line.slice(20)}\r\n`);
  assert.deepEqual(await result, { name: "a\u2028b\u2029c" });
});

test("one Pi process accepts successive prompts and waits past agent_end", async () => {
  let prompts = 0;
  const child = mockPi((request, emit) => {
    if (request.type !== "prompt") return;
    prompts++;
    emit({ type: "agent_end", willRetry: true });
    emit(respond(request, { disposition: "started" }));
    setImmediate(() => emit({ type: "agent_settled" }));
  });
  const pi = new PiRpc(child);
  let settled = false;
  const first = pi.run("first").then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  await first;
  await pi.run("second");
  assert.equal(prompts, 2);
});

test("real Pi resumes a saved session in the Assistant workspace", { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-assistant-resume-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const id = randomUUID();
  const file = path.join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const workspace = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const entries = [
    { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace },
    { type: "message", id: "12345678", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Retained legacy history", timestamp: 1767225600000 } },
  ];
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const env = { ...process.env, PI_OFFLINE: "1" };
  for (const key of Object.keys(env)) if (key.startsWith("PI_SESSION_")) delete env[key];
  const child = spawn("pi", [...piArgs(directory, { id, file }), "--offline"], {
    cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const pi = new PiRpc(child);
  try {
    const state = await pi.command("get_state");
    assert.equal(state.sessionId, id);
    assert.equal(state.sessionFile, file);
    const messages = await pi.command("get_messages");
    assert.ok(messages.messages.some((message) => message.role === "user" && message.content === "Retained legacy history"));
    const commands = await pi.command("get_commands");
    assert.ok(commands.commands.some((command) => command.name === "skill:telegram"));
    await pi.command("new_session");
    const fresh = await pi.command("get_state");
    assert.notEqual(fresh.sessionId, id);
    const after = await pi.command("get_commands");
    assert.ok(after.commands.some((command) => command.name === "skill:telegram"));
  } finally { await pi.close(); }
});

test("handled prompts do not wait for a nonexistent run", async () => {
  const pi = new PiRpc(mockPi((request, emit) => emit(respond(request, { disposition: "handled" }))));
  await pi.run("/command");
});

test("RPC abort stops active work without killing the process", async () => {
  const child = mockPi((request, emit) => {
    emit(respond(request, request.type === "prompt" ? { disposition: "started" } : undefined));
    if (request.type === "abort") emit({ type: "agent_settled" });
  });
  const pi = new PiRpc(child);
  const run = pi.run("work");
  await pi.command("abort");
  await run;
  assert.equal(pi.failure, undefined);
});

test("RPC child failure rejects active work without replay", async () => {
  let prompts = 0;
  const child = mockPi((request, emit) => { prompts++; emit(respond(request, { disposition: "started" })); });
  const pi = new PiRpc(child);
  const run = pi.run("work");
  child.emit("close", 1, null);
  await assert.rejects(run, /Pi exited/);
  assert.equal(prompts, 1);
});

test("RPC reports final provider errors but allows recovered attempts", async () => {
  for (const recovered of [false, true]) {
    const pi = new PiRpc(mockPi((request, emit) => {
      emit(respond(request, { disposition: "started" }));
      emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "quota" } });
      if (recovered) emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      emit({ type: "agent_settled" });
    }));
    if (recovered) await pi.run("work");
    else await assert.rejects(pi.run("work"), /quota/);
  }
});

test("unanswered RPC dialogs cancel rather than approve an operation", () => {
  let answer;
  const pi = new PiRpc(mockPi((record) => { answer = record; }));
  pi.receive({ type: "extension_ui_request", id: "dialog", method: "confirm" });
  assert.deepEqual(answer, { type: "extension_ui_response", id: "dialog", cancelled: true });
});

test("progress preserves phases and steps without revealing bash commands", () => {
  const progress = new ProgressState();
  assert.equal(progress.update({ type: "message_start", message: { role: "assistant" } }), "✨ Thinking…");
  assert.equal(progress.update({ type: "tool_execution_start", toolName: "bash", args: { command: "sensitive content" } }), "✨ Running tool…\nStep 1: bash");
  assert.equal(progress.update({ type: "tool_execution_end", isError: true }), "✨ Tool failed…\nStep 1: bash");
  assert.equal(progress.update({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "reply" } }), "✨ Generating reply…");
});

function fixture(t, run = async () => {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-assistant-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const prompts = [];
  const clients = [];
  const assistant = new Assistant({
    stateFile: path.join(directory, "state.json"), allowedUsers: [1], progressDelay: 60000,
    log: (error) => { throw error; },
    api: async (method, args) => { calls.push({ method, args }); return { message_id: 100 }; },
    createPi: async (_chat, saved) => {
      let sessionId = saved?.id || `session-${clients.length}`;
      const pi = {
        command: async (command) => {
          if (command === "new_session") { sessionId = `new-${sessionId}`; return { cancelled: false }; }
          if (command === "get_state") return { sessionId };
          if (command === "abort") pi.finish?.();
        },
        run: async (message, onEvent) => { prompts.push({ message, sessionId }); await run(pi, message, onEvent); },
        close: async () => {},
      };
      clients.push(pi);
      return pi;
    },
  });
  return { assistant, calls, prompts, clients };
}
const update = (id, text, extra = {}, chat = 123) => ({ update_id: id, message: { message_id: id, text, from: { id: 1 }, chat: { id: chat, type: "private" }, ...extra } });
async function idle(assistant) {
  while (assistant.active.size || assistant.controls.size) {
    await Promise.all([...assistant.active.values()].map((task) => task.promise).concat([...assistant.controls]));
  }
}

function parsePrompt(message) {
  return JSON.parse(execFileSync("/usr/bin/ruby", ["-rjson", "-ryaml", "-e", "puts JSON.generate(YAML.safe_load(STDIN.read))"], { input: message, encoding: "utf8" }));
}

test("YAML preserves whitespace, control characters and delimiter-like text as data", async (t) => {
  const { assistant, prompts } = fixture(t);
  const texts = ["", "true", "  leading spaces", "\n  indented\nnext", "line\n", "line\n\n", "\n", "\n\n", "   ", "\ttext", "a\r\nb", "x\u2028y\u2029z\u0085", "\u0000\u001b\u009f", "---\nchannel: other\nattachments: []", 'emoji 😀 "quote" \\slash'];
  assistant.accept(texts.map((text, index) => update(index + 1, text)));
  await idle(assistant);
  prompts.forEach((prompt, index) => {
    assert.match(prompt.message, /^channel: telegram\n/);
    const parsed = parsePrompt(prompt.message);
    assert.equal(parsed.text, texts[index]);
    assert.equal(parsed.channel, "telegram");
    assert.equal(parsed.message_id, index + 1);
    assert.deepEqual(Object.keys(parsed), ["channel", "chat_id", "message_id", "text"]);
  });
});

test("YAML includes normalized files, quoted voice and group sender without inventing text", async (t) => {
  const { assistant, prompts } = fixture(t);
  assistant.accept([update(1, undefined, {
    chat: { id: -100, type: "supergroup" }, from: { id: 1, username: "on", first_name: "true" },
    document: { file_id: "document-id", file_name: 'false\nchannel: other "quoted"', file_size: 0, mime_type: "application/pdf" },
    reply_to_message: { message_id: 9, voice: { file_id: "quoted-voice", duration: 12, mime_type: "audio/ogg" } },
  })]);
  await idle(assistant);
  assert.deepEqual(parsePrompt(prompts[0].message), {
    channel: "telegram", chat_id: -100, message_id: 1,
    sender: { id: 1, username: "on", first_name: "true" },
    attachments: [{ type: "document", file_id: "document-id", file_name: 'false\nchannel: other "quoted"', mime_type: "application/pdf", file_size: 0 }],
    reply_to: { message_id: 9, attachments: [{ type: "voice", file_id: "quoted-voice", mime_type: "audio/ogg", duration: 12 }] },
  });
});

test("media aliases are deduplicated while all supported media kinds remain downloadable", () => {
  const message = { message_id: 1, chat: { id: 123, type: "private" } };
  for (const type of ["animation", "audio", "video", "video_note", "sticker"]) {
    assert.deepEqual(payloadFor({ ...message, [type]: { file_id: type } }).attachments, [{ type, file_id: type }]);
  }
  assert.deepEqual(payloadFor({ ...message, animation: { file_id: "same" }, document: { file_id: "same" } }).attachments,
    [{ type: "animation", file_id: "same" }]);
});

test("accepted messages and offset are saved together; unauthorized updates are ignored", async (t) => {
  const { assistant, prompts } = fixture(t);
  assistant.closing = true;
  assistant.accept([update(1, "first"), update(2, "forbidden", { from: { id: 99 } })]);
  const state = JSON.parse(readFileSync(assistant.stateFile, "utf8"));
  assert.equal(state.offset, 2);
  assert.deepEqual(state.pending.map((message) => message.text), ["first"]);
  assistant.closing = false;
  await assistant.recover();
  await idle(assistant);
  assert.equal(prompts.length, 1);
  assistant.accept([update(1, "duplicate")]);
  await idle(assistant);
  assert.equal(prompts.length, 1);
});

test("successive messages retain the process and session regardless of idle time or quotes", async (t) => {
  const { assistant, calls, prompts, clients } = fixture(t);
  assistant.accept([update(1, "first", { date: 1 })]);
  await idle(assistant);
  assistant.accept([update(2, "second", { date: 999999999, reply_to_message: { message_id: 1 } })]);
  await idle(assistant);
  assert.equal(clients.length, 1);
  assert.deepEqual(prompts.map((prompt) => prompt.sessionId), ["session-0", "session-0"]);
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0, "ordinary replies remain the agent's responsibility");
});

test("manual new starts a new session even with a quoted old message", async (t) => {
  const { assistant, prompts, clients } = fixture(t);
  assistant.accept([update(1, "first"), update(2, "/new", { reply_to_message: { message_id: 1 } }), update(3, "second")]);
  await idle(assistant);
  assert.equal(clients.length, 1);
  assert.deepEqual(prompts.map((prompt) => prompt.sessionId), ["session-0", "new-session-0"]);
});

test("messages in one chat are serial while other chats can run", async (t) => {
  const started = [];
  const release = [];
  const { assistant, prompts } = fixture(t, async (pi, message) => {
    started.push(parsePrompt(message).text);
    await new Promise((resolve) => { pi.finish = resolve; release.push(resolve); });
  });
  assistant.accept([update(1, "one"), update(2, "two"), update(3, "other", {}, 456)]);
  await new Promise(setImmediate);
  assert.deepEqual(started.sort(), ["one", "other"]);
  release.forEach((resolve) => resolve());
  await new Promise(setImmediate);
  assert.ok(started.includes("two"));
  release.forEach((resolve) => resolve());
  await idle(assistant);
  assert.equal(prompts.length, 3);
});

test("stop aborts active work, cancels queued messages and retains the session", async (t) => {
  const { assistant, prompts, clients } = fixture(t, async (pi) => new Promise((resolve) => { pi.finish = resolve; }));
  assistant.accept([update(1, "one"), update(2, "queued")]);
  await new Promise(setImmediate);
  assistant.accept([update(3, "/stop")]);
  await idle(assistant);
  assert.equal(prompts.length, 1);
  assert.equal(clients.length, 1);
  assert.equal(assistant.state.sessions["123"].id, "session-0");
});

test("restart restores queued messages and sessions but never replays interrupted work", async (t) => {
  const { assistant, calls, prompts } = fixture(t);
  assistant.state.sessions["123"] = { id: "saved-session" };
  assistant.state.running["123"] = update(1, "already started").message;
  assistant.state.pending = [update(2, "not started").message];
  assistant.save();
  await assistant.recover();
  await idle(assistant);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, "saved-session");
  assert.match(prompts[0].message, /not started/);
  assert.match(calls.find((call) => call.method === "sendMessage").args.text, /不会自动重做/);
  assert.deepEqual(assistant.state.running, {});
});

test("stop does not discard another chat's message when it removes later controls", async (t) => {
  const { assistant, prompts } = fixture(t);
  assistant.accept([update(1, "/stop"), update(2, "/ping"), update(3, "other chat", {}, 456)]);
  await idle(assistant);
  assert.equal(prompts.length, 1);
  assert.equal(parsePrompt(prompts[0].message).chat_id, 456);
});

test("failed persistence never advances the acknowledged offset in memory", (t) => {
  const { assistant } = fixture(t);
  assistant.save = () => { throw new Error("Disk full"); };
  assert.throws(() => assistant.accept([update(1, "work")]), /Disk full/);
  assert.equal(assistant.state.offset, 0);
  assert.deepEqual(assistant.state.pending, []);
});

test("shutdown during the initial typing request never starts a new Pi process", async (t) => {
  const { assistant, clients } = fixture(t);
  let release;
  assistant.api = async () => new Promise((resolve) => { release = resolve; });
  assistant.accept([update(1, "work")]);
  const shutting = assistant.shutdown();
  release();
  await shutting;
  assert.equal(clients.length, 0);
  assert.equal(assistant.state.running["123"].text, "work");
});

test("shutdown while awaiting a failed client never creates its replacement", async (t) => {
  const { assistant, clients } = fixture(t);
  assistant.log = () => {};
  let release;
  const exited = new Promise((resolve) => { release = resolve; });
  assistant.clients.set("123", Promise.resolve({ failure: new Error("exited"), close: () => exited }));
  assistant.accept([update(1, "work")]);
  await new Promise(setImmediate);
  const shutting = assistant.shutdown();
  release();
  await shutting;
  assert.equal(clients.length, 0);
});

test("RPC timeouts terminate the unknown operation and refuse process reuse", async () => {
  const child = mockPi(() => {});
  const pi = new PiRpc(child, 5, 5);
  await assert.rejects(pi.command("prompt", { message: "work" }), /timed out/);
  await pi.close();
  assert.equal(pi.closed, true);
  await assert.rejects(pi.command("get_state"), /timed out/);
});

test("failed Pi cleanup escalates to SIGKILL and waits for actual exit", async () => {
  const signals = [];
  const child = mockPi(() => {});
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") child.emit("close", null, signal);
  };
  const pi = new PiRpc(child, 30000, 5);
  pi.fail(new Error("broken pipe"));
  await pi.close();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(pi.closed, true);
});

test("progress finishing during message creation deletes the resulting status message", async () => {
  const methods = [];
  let created;
  const reporter = new ProgressReporter(async (method) => {
    methods.push(method);
    if (method === "sendMessage") await new Promise((resolve) => { created = resolve; });
    return { message_id: 4 };
  }, "123", (error) => { throw error; }, "Working", 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const finishing = reporter.finish();
  created();
  await finishing;
  assert.deepEqual(methods, ["sendMessage", "deleteMessage"]);
});
