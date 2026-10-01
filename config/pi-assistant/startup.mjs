import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));

function messageFields(message) {
  const attachments = [];
  for (const type of ["photo", "animation", "document", "voice", "audio", "video", "video_note", "sticker"]) {
    const media = type === "photo" ? message.photo?.reduce((largest, photo) =>
      photo.width * photo.height > largest.width * largest.height ? photo : largest) : message[type];
    if (!media || attachments.some((item) => item.file_id === media.file_id)) continue;
    attachments.push({ type, ...pick(media, ["file_id", "file_name", "mime_type", "file_size", "width", "height", "duration"]) });
  }
  const text = message.text ?? message.caption;
  const sender = message.sender_chat || message.from;
  return {
    message_id: message.message_id,
    ...(text !== undefined ? { text } : {}),
    ...(message.chat?.type && message.chat.type !== "private" && sender
      ? { sender: pick(sender, ["id", "username", "first_name", "last_name", "title"]) } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

export function payloadFor(message) {
  return {
    channel: "telegram", chat_id: message.chat.id, ...messageFields(message),
    ...(message.reply_to_message ? { reply_to: messageFields(message.reply_to_message) } : {}),
  };
}

function yamlFor(value, indent = 0) {
  const prefix = " ".repeat(indent);
  return Object.entries(value).map(([key, item]) => {
    if (Array.isArray(item)) return `${prefix}${key}:\n${item.map((entry) => `${prefix}  - ${yamlFor(entry, indent + 4).slice(indent + 4)}`).join("")}`;
    if (item !== null && typeof item === "object") return `${prefix}${key}:\n${yamlFor(item, indent + 2)}`;
    if (key === "text" && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff]/.test(item)) {
      const lines = item.replace(/\n$/, "").split("\n");
      return `${prefix}${key}: |2${item.endsWith("\n") ? "+" : "-"}\n${lines.map((line) => `${prefix}  ${line}\n`).join("")}`;
    }
    const scalar = ["channel", "type"].includes(key) ? item : JSON.stringify(item)
      .replace(/[\u007f-\u009f\u2028\u2029\ufffe\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return `${prefix}${key}: ${scalar}\n`;
  }).join("");
}

export function piArgs(sessionDir, session) {
  // --session adopts the saved cwd; --session-id retains the Assistant workspace.
  return ["--mode", "rpc", "--approve", "--session-dir", session?.file ? path.dirname(session.file) : sessionDir,
    "--exclude-tools", "questionnaire", ...(session?.id ? ["--session-id", session.id] : [])];
}

export class PiRpc extends EventEmitter {
  constructor(child, timeoutMs = 30000, killTimeoutMs = 5000) {
    super();
    this.child = child;
    this.pending = new Map();
    this.nextId = 0;
    this.timeoutMs = timeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.exited = new Promise((resolve) => child.once("close", () => {
      this.closed = true;
      clearTimeout(this.killTimer);
      resolve();
    }));
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end).replace(/\r$/, "");
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.fail(new Error("Invalid Pi RPC record")); }
      }
    });
    child.stdin.on("error", (error) => this.fail(error));
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) => this.fail(new Error(`Pi exited (${signal || code})`)));
  }

  receive(event) {
    if (event.type === "response") {
      const request = this.pending.get(event.id);
      if (!request) return;
      this.pending.delete(event.id);
      clearTimeout(request.timer);
      if (event.success) request.resolve(event.data);
      else request.reject(new Error(event.error || `${event.command} failed`));
    } else if (event.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
      }
    } else {
      this.emit("event", event);
    }
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit("failure", error);
    if (!this.closed) {
      this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), this.killTimeoutMs);
      this.child.kill("SIGTERM");
    }
  }

  command(type, args = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Pi RPC ${type} timed out`)), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...args, type, id })}\n`);
    });
  }

  async run(message, onEvent = () => {}) {
    let finalError;
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    // A child can exit before the prompt response; observe rejection immediately.
    done.catch(() => {});
    const receive = (event) => {
      onEvent(event);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        finalError = event.message.stopReason === "error" ? event.message.errorMessage || "Pi request failed" : undefined;
      }
      if (event.type === "agent_settled") {
        if (finalError) rejectDone(new Error(finalError));
        else resolveDone();
      }
    };
    this.on("event", receive);
    this.on("failure", rejectDone);
    try {
      const result = await this.command("prompt", { message });
      if (result?.disposition === "handled") resolveDone();
      await done;
    } finally {
      this.off("event", receive);
      this.off("failure", rejectDone);
    }
  }

  async close() {
    if (this.closed) return;
    if (!this.failure) this.child.stdin.end();
    if (!this.killTimer) this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), this.killTimeoutMs);
    await this.exited;
  }
}

export class ProgressState {
  constructor() { this.phase = "Thinking"; this.steps = 0; this.detail = ""; }
  update(event) {
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.phase = "Thinking";
      this.detail = "";
    } else if (event.type === "tool_execution_start") {
      this.phase = "Running tool";
      this.steps++;
      const name = event.toolName?.split(".").at(-1) || "tool";
      const args = event.args || {};
      // Do not publish raw commands, which may contain credentials or user content.
      this.detail = ["read", "edit", "write"].includes(name) && args.path
        ? `${name}: ${String(args.path).slice(0, 56)}` : name;
    } else if (event.type === "tool_execution_end" && event.isError) {
      this.phase = "Tool failed";
    } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.phase = "Generating reply";
      this.detail = "";
    } else if (event.type === "compaction_start") {
      this.phase = "Compacting context";
    } else if (event.type === "auto_retry_start") {
      this.phase = `Retrying ${event.attempt}/${event.maxAttempts}`;
    } else return;
    return `✨ ${this.phase}…${this.detail ? `\nStep ${this.steps}: ${this.detail}` : ""}`;
  }
}

export class ProgressReporter {
  constructor(api, chatId, log, initial = "✨ Please wait…", delay = 1000) {
    this.api = api;
    this.chatId = chatId;
    this.log = log;
    this.desired = initial;
    this.creation = Promise.resolve();
    this.timer = setTimeout(() => {
      const text = this.desired;
      this.creation = api("sendMessage", { chat_id: chatId, text, disable_notification: true })
        .then((message) => { this.id = message.message_id; this.last = text; })
        .catch(log);
    }, delay);
    this.ticker = setInterval(() => {
      if (!this.id || this.edit || this.desired === this.last) return;
      const text = this.desired;
      this.edit = api("editMessageText", { chat_id: chatId, message_id: this.id, text })
        .then(() => { this.last = text; }).catch(log).finally(() => { this.edit = undefined; });
    }, 1000);
  }
  update(text) { this.desired = text; }
  async finish() {
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    await this.creation;
    await this.edit;
    if (this.id) await this.api("deleteMessage", { chat_id: this.chatId, message_id: this.id }).catch(this.log);
  }
}

export class Assistant {
  constructor({ stateFile, api, allowedUsers, createPi, log = console.error, progressDelay = 1000 }) {
    this.stateFile = stateFile;
    this.api = api;
    this.allowedUsers = new Set(allowedUsers);
    this.createPi = createPi;
    this.log = log;
    this.progressDelay = progressDelay;
    this.state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8"))
      : { offset: 0, sessions: {}, pending: [], running: {} };
    this.clients = new Map();
    this.active = new Map();
    this.controls = new Set();
  }
  save(state = this.state) {
    mkdirSync(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temporary, this.stateFile);
    this.state = state;
  }
  async text(chat, text) { await this.api("sendMessage", { chat_id: chat, text }); }
  async recover() {
    for (const [chat, message] of Object.entries(this.state.running)) {
      await this.text(chat, `⚠️ 上次任务（消息 ${message.message_id}）已中断，不会自动重做。需要继续时请发消息。`).catch(this.log);
      delete this.state.running[chat];
      this.save();
    }
    this.drain();
  }
  accept(updates) {
    const next = { ...this.state, pending: [...this.state.pending] };
    for (const update of updates) {
      if (update.update_id <= next.offset) continue;
      next.offset = update.update_id;
      const message = update.message;
      if (message?.chat && this.allowedUsers.has(message.from?.id)) next.pending.push(message);
    }
    // Persist accepted messages and their offset together, before the next poll acknowledges them.
    this.save(next);
    this.drain();
  }
  command(message) { return (message.text || "").split(/\s/)[0].split("@")[0].toLowerCase(); }
  drain() {
    if (this.closing) return;
    for (const message of [...this.state.pending]) {
      if (["/ping", "/status", "/stop", "/help", "/logs", "/restart"].includes(this.command(message))) {
        const index = this.state.pending.indexOf(message);
        if (index < 0) continue;
        this.state.pending.splice(index, 1);
        this.save();
        const task = this.control(message).catch(this.log).finally(() => this.controls.delete(task));
        this.controls.add(task);
      }
    }
    for (const chat of new Set(this.state.pending.map((message) => String(message.chat.id)))) {
      if (this.active.has(chat)) continue;
      const active = { stopped: false };
      this.active.set(chat, active);
      active.promise = this.processChat(chat, active).catch(this.log).finally(() => {
        this.active.delete(chat);
        this.drain();
      });
    }
  }
  async client(chat) {
    if (this.clients.has(chat)) {
      const existing = await this.clients.get(chat);
      if (!existing.failure) return existing;
      await existing.close();
      this.clients.delete(chat);
    }
    if (this.closing) throw new Error("Assistant is shutting down");
    const client = this.createPi(chat, this.state.sessions[chat]);
    this.clients.set(chat, client);
    try {
      const pi = await client;
      const state = await pi.command("get_state");
      this.state.sessions[chat] = { id: state.sessionId, file: state.sessionFile };
      this.save();
      return pi;
    } catch (error) {
      this.clients.delete(chat);
      const pi = await client.catch(() => undefined);
      await pi?.close();
      throw error;
    }
  }
  async processChat(chat, active) {
    while (!this.closing && !active.stopped) {
      const index = this.state.pending.findIndex((message) => String(message.chat.id) === chat);
      if (index < 0) break;
      const [message] = this.state.pending.splice(index, 1);
      this.state.running[chat] = message;
      this.save();
      const fresh = this.command(message) === "/new";
      const progress = new ProgressReporter(this.api, chat, this.log, fresh ? "✨ New session…" : "✨ Please wait…", this.progressDelay);
      const typing = setInterval(() => this.api("sendChatAction", { chat_id: chat, action: "typing" }).catch(this.log), 4500);
      try {
        await this.api("sendChatAction", { chat_id: chat, action: "typing" }).catch(this.log);
        if (active.stopped || this.closing) break;
        const pi = await this.client(chat);
        if (active.stopped || this.closing) break;
        if (fresh) {
          const result = await pi.command("new_session");
          if (result?.cancelled) throw new Error("Pi cancelled the new session");
          const state = await pi.command("get_state");
          this.state.sessions[chat] = { id: state.sessionId, file: state.sessionFile };
          this.save();
          await this.text(chat, "🆕 已开启新会话。后续消息会沿用它。");
        } else {
          const status = new ProgressState();
          await pi.run(yamlFor(payloadFor(message)), (event) => {
            const text = status.update(event);
            if (text) progress.update(text);
          });
          // Assistant text is intentionally not forwarded. The agent sends replies through its skill.
          const state = await pi.command("get_state");
          this.state.sessions[chat] = { id: state.sessionId, file: state.sessionFile };
          this.save();
        }
      } catch (error) {
        this.log(error);
        if (!this.closing && !active.stopped) await this.text(chat, "🔴 处理失败，不会自动重做。请重新发消息，或用 /logs 查看错误。").catch(this.log);
      } finally {
        clearInterval(typing);
        await progress.finish();
        if (!this.closing) {
          delete this.state.running[chat];
          this.save();
        }
      }
    }
  }
  async control(message) {
    const chat = String(message.chat.id);
    const command = this.command(message);
    if (command === "/ping") return this.text(chat, "🏓 Pong!");
    if (command === "/help") return this.text(chat, "/ping — 检查状态\n/status — 运行与会话信息\n/new — 手动开启新会话（当前任务结束后按顺序执行）\n/stop — 停止当前任务，并取消本聊天排队消息\n/logs — 最近服务日志\n/restart — 重启服务，保留会话\n/help — 帮助");
    if (command === "/status") {
      return this.text(chat, `状态: ${this.active.has(chat) ? "运行中" : "空闲"}\n会话: ${this.state.sessions[chat]?.id || "尚未开始"}\n排队消息: ${this.state.pending.filter((item) => String(item.chat.id) === chat).length}`);
    }
    if (command === "/logs") {
      const logFile = path.join(path.dirname(this.stateFile), "pi-assistant.log");
      const text = existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").slice(-20).join("\n").slice(-3500) : "暂无日志。";
      return this.text(chat, text || "暂无日志。");
    }
    if (command === "/restart") {
      await this.text(chat, "♻️ 正在重启。会话会保留，执行中的任务不会自动重做。");
      process.kill(process.pid, "SIGTERM");
      return;
    }
    const active = this.active.get(chat);
    if (active) active.stopped = true;
    this.state.pending = this.state.pending.filter((item) => String(item.chat.id) !== chat);
    this.save();
    const pi = await this.clients.get(chat);
    if (pi && !pi.failure) {
      await pi.command("clear_queue");
      await pi.command("abort");
    }
    await this.text(chat, "🛑 已停止当前任务，并取消排队消息。会话保留。");
  }
  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.clients.values()].map(async (client) => {
      const pi = await client;
      try { if (!pi.failure) { await pi.command("clear_queue"); await pi.command("abort"); } }
      finally { await pi.close(); }
    }));
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    await Promise.allSettled(this.controls);
  }
}

export async function main() {
  process.loadEnvFile(path.join(root, "pi-assistant.env"));
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS || "").split(/[\s,]+/).filter(Boolean).map(Number);
  if (!token || !allowedUsers.length || allowedUsers.some((id) => !Number.isSafeInteger(id))) throw new Error("Telegram token and allowed users must be configured");
  const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local/state"), "pi-assistant");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = (error) => console.error(`[${new Date().toISOString()}] ${String(error?.message || error).replaceAll(token, "[REDACTED]")}`);
  const polling = new AbortController();
  let closing = false;
  const api = async (method, payload) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      signal: method === "getUpdates" ? AbortSignal.any([polling.signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
    return result.result;
  };
  if (process.argv.includes("--check")) {
    const bot = await api("getMe", {});
    console.log(`Telegram bot @${bot.username}; ${allowedUsers.length} allowed user(s)`);
    return;
  }
  const assistant = new Assistant({
    stateFile: path.join(stateDir, "state.json"), api, allowedUsers, log,
    createPi: async (chat, session) => {
      const sessionDir = path.join(stateDir, "sessions", chat);
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      const args = piArgs(sessionDir, session);
      const env = { ...process.env, PI_CODING_AGENT_DIR: path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "pi"), TELEGRAM_DEFAULT_CHAT_ID: chat };
      for (const key of Object.keys(env)) if (key.startsWith("PI_SESSION_")) delete env[key];
      const child = spawn("pi", args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text) => log(text.trim()));
      return new PiRpc(child);
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { closing = true; polling.abort(); });
  try {
    await assistant.recover();
    await api("getMe", {});
    console.log(`[${new Date().toISOString()}] Assistant online; offset=${assistant.state.offset}`);
    while (!closing) {
      try {
        const updates = await api("getUpdates", { offset: assistant.state.offset + 1, timeout: 60, limit: 50, allowed_updates: ["message"] });
        assistant.accept(updates);
      } catch (error) {
        if (!closing) { log(error); await sleep(2000); }
      }
    }
  } finally { await assistant.shutdown(); }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
