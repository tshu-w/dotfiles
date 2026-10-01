import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { Assistant, commandPreview, payloadFor, piArgs, PiRun, ProgressReporter, ProgressState, sessionFile } from "../startup.mjs";

function mockChild(onInput = () => {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) { onInput(String(chunk)); done(); } });
  child.emitJson = (record) => child.stdout.write(`${JSON.stringify(record)}\n`);
  child.exit = (code, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit("close", code, signal); };
  child.kill = (signal) => child.exit(null, signal);
  return child;
}

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

test("a run records its session, accepts split records and settles with the final assistant outcome", async () => {
  const child = mockChild();
  const events = [];
  const run = new PiRun(child, (event) => events.push(event.type));
  const line = JSON.stringify({ type: "session", id: "s1", cwd: "/tmp/a\u2028b" });
  child.stdout.write(line.slice(0, 15));
  child.stdout.write(`${line.slice(15)}\r\n`);
  assert.equal(await run.session, "s1");
  child.emitJson({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider down" } });
  child.emitJson({ type: "agent_end", willRetry: true });
  child.emitJson({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  child.emitJson({ type: "agent_settled" });
  await run.done;
  assert.deepEqual(events, ["session", "message_end", "agent_end", "message_end", "agent_settled"]);
});

test("a run fails on a final provider error or an early exit", async () => {
  const failed = mockChild();
  const failing = new PiRun(failed);
  failed.emitJson({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "quota" } });
  failed.emitJson({ type: "agent_settled" });
  await assert.rejects(failing.done, /quota/);
  const crashed = mockChild();
  const crashing = new PiRun(crashed);
  crashed.exit(1);
  await assert.rejects(crashing.done, /Pi exited \(1\)/);
  assert.equal(await crashing.session, undefined);
});

test("stopping a run terminates Pi, escalates to SIGKILL and is not an error", async () => {
  const signals = [];
  const child = mockChild();
  child.kill = (signal) => { signals.push(signal); if (signal === "SIGKILL") child.exit(null, signal); };
  const run = new PiRun(child, () => {}, 5);
  await run.stop();
  await run.done;
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

function offlinePi(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-assistant-offline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A provider that cannot be reached: Pi records the user message, then settles with an error.
  writeFileSync(path.join(directory, "models.json"), JSON.stringify({ providers: { offline: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "none", models: [{ id: "unreachable" }] } } }));
  writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  const workspace = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const env = { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: directory };
  for (const key of Object.keys(env)) if (/_API_KEY$|_TOKEN$|^PI_SESSION_|^PI_CODING_AGENT_SESSION_DIR$/.test(key)) delete env[key];
  return { directory, workspace, run: (session, message) => {
    const child = spawn("pi", [...piArgs(session), "--offline", "--model", "offline/unreachable"], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    child.stdin.end(message);
    return new PiRun(child);
  } };
}

test("real Pi names a new session, stores it in the default directory and resumes it by id", { timeout: 60000 }, async (t) => {
  const { directory, workspace, run } = offlinePi(t);
  const root = path.join(directory, "sessions");
  const first = run({ chat: "123" }, "channel: telegram\ntext: first\n");
  const id = await first.session;
  await assert.rejects(first.done, /Connection error|ECONNREFUSED|fetch failed/i);
  const file = sessionFile(root, id, workspace);
  assert.equal(path.dirname(path.dirname(file)), root);
  mkdirSync(path.join(root, "--elsewhere--"));
  writeFileSync(path.join(root, "--elsewhere--", path.basename(file)), JSON.stringify({ type: "session", id, cwd: "/elsewhere" }) + "\n");
  assert.equal(sessionFile(root, id, workspace), file, "a stale copy from another workspace is not preferred");
  const entries = () => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries().find((entry) => entry.type === "session_info")?.name, "telegram:123");
  assert.ok(entries().some((entry) => entry.type === "message" && entry.message.role === "user" && /text: first/.test(JSON.stringify(entry.message.content))));
  const second = run({ id }, "channel: telegram\ntext: second\n");
  assert.equal(await second.session, id);
  await assert.rejects(second.done);
  assert.equal(sessionFile(root, id, workspace), file);
  const users = entries().filter((entry) => entry.type === "message" && entry.message.role === "user");
  assert.equal(users.length, 2);
  assert.equal(readFileSync(file, "utf8").split("session_info").length, 2, "resuming does not rename the session");
});

test("progress preserves phases and steps and redacts bash command previews", () => {
  const progress = new ProgressState();
  assert.equal(progress.update({ type: "message_start", message: { role: "assistant" } }), "✨ Thinking…");
  assert.equal(progress.update({ type: "tool_execution_start", toolName: "bash", args: { command: "curl  -s \n https://x/?api_key=k1 token=abc " } }),
    "✨ Running tool…\nStep 1: $ curl -s https://x/?api_key=*** token=***");
  assert.equal(progress.update({ type: "tool_execution_end", isError: true }), "✨ Tool failed…\nStep 1: $ curl -s https://x/?api_key=*** token=***");
  assert.equal(commandPreview(`echo ${"A".repeat(40)} && ${"ls -la ".repeat(12)}`), "echo *** && ls -la ls -la ls -la ls -la ls -la ls -la l…");
  assert.equal(progress.update({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "reply" } }), "✨ Generating reply…");
});

function fixture(t, run = async () => {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-assistant-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const prompts = [];
  const runs = [];
  const missing = new Set();
  const assistant = new Assistant({
    stateFile: path.join(directory, "state.json"), allowedUsers: [1], progressDelay: 60000,
    log: (error) => { throw error; },
    api: async (method, args) => { calls.push({ method, args }); return { message_id: 100 }; },
    sessionExists: (id) => !missing.has(id),
    createPi: (_chat, session, message, onEvent) => {
      const id = session.id || `session-${runs.length}`;
      const pi = { session: Promise.resolve(id), stopped: false };
      pi.stop = async () => { pi.stopped = true; pi.finish?.(); };
      prompts.push({ message, sessionId: id, name: session.id ? undefined : `telegram:${session.chat}` });
      pi.done = run(pi, message, onEvent);
      runs.push(pi);
      return pi;
    },
  });
  return { assistant, calls, prompts, runs, missing };
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

test("successive messages reuse the saved session; a missing session file starts a new named one", async (t) => {
  const { assistant, prompts, missing } = fixture(t);
  assistant.accept([update(1, "first", { date: 1 })]);
  await idle(assistant);
  assistant.accept([update(2, "second", { date: 999999999, reply_to_message: { message_id: 1 } })]);
  await idle(assistant);
  assert.deepEqual(prompts.map((prompt) => [prompt.sessionId, prompt.name]), [["session-0", "telegram:123"], ["session-0", undefined]]);
  missing.add("session-0");
  assistant.log = () => {};
  assistant.accept([update(3, "third")]);
  await idle(assistant);
  assert.deepEqual(prompts.at(-1).name, "telegram:123");
  assert.notEqual(assistant.state.sessions["123"].id, "session-0");
});

test("manual new forgets the session so the next message starts a new one", async (t) => {
  const { assistant, prompts, calls } = fixture(t);
  assistant.accept([update(1, "first"), update(2, "/new", { reply_to_message: { message_id: 1 } }), update(3, "second")]);
  await idle(assistant);
  assert.deepEqual(prompts.map((prompt) => prompt.sessionId), ["session-0", "session-1"]);
  assert.ok(calls.some((call) => call.method === "sendMessage" && /新会话/.test(call.args.text)));
});

test("stop terminates active work, cancels queued messages and retains the session", async (t) => {
  const { assistant, prompts, runs } = fixture(t, async (pi) => new Promise((resolve) => { pi.finish = resolve; }));
  assistant.accept([update(1, "one"), update(2, "queued")]);
  await new Promise(setImmediate);
  assistant.accept([update(3, "/stop")]);
  await idle(assistant);
  assert.equal(prompts.length, 1);
  assert.equal(runs[0].stopped, true);
  assert.equal(assistant.state.sessions["123"].id, "session-0");
});

test("failed runs are reported once and the session is still remembered", async (t) => {
  const { assistant, calls } = fixture(t, async () => { throw new Error("provider down"); });
  assistant.log = () => {};
  assistant.accept([update(1, "work")]);
  await idle(assistant);
  assert.equal(calls.filter((call) => call.method === "sendMessage" && /处理失败/.test(call.args.text)).length, 1);
  assert.equal(assistant.state.sessions["123"].id, "session-0");
  assert.deepEqual(assistant.state.running, {});
});

test("shutdown stops the active run and keeps the interrupted message for recovery", async (t) => {
  const { assistant, runs } = fixture(t, async (pi) => new Promise((resolve) => { pi.finish = resolve; }));
  assistant.accept([update(1, "work")]);
  await new Promise(setImmediate);
  await assistant.shutdown();
  assert.equal(runs[0].stopped, true);
  assert.equal(assistant.state.running["123"].text, "work");
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
  const { assistant, runs } = fixture(t);
  let release;
  assistant.api = async () => new Promise((resolve) => { release = resolve; });
  assistant.accept([update(1, "work")]);
  const shutting = assistant.shutdown();
  release();
  await shutting;
  assert.equal(runs.length, 0);
  assert.equal(assistant.state.running["123"].text, "work");
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
