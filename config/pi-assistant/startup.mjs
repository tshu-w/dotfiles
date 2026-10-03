import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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
    chat_id: message.chat.id, ...messageFields(message),
    ...(message.reply_to_message ? { reply_to: messageFields(message.reply_to_message) } : {}),
  };
}

const attributes = (fields) => Object.entries(fields).map(([key, value]) =>
  ` ${key}="${String(value).replace(/[&"<\n]/g, (char) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", "\n": "&#10;" })[char])}"`).join("");

// The message as the model reads it: sender, text, attachments, then the quoted message.
function elementFor(name, { sender, text, attachments = [], reply_to, ...fields }) {
  const lines = [`<${name}${attributes(fields)}>`];
  if (sender) lines.push(`<sender${attributes(sender)}/>`);
  if (text !== undefined) lines.push(text.replace(/\n+$/, ""));
  lines.push(...attachments.map((attachment) => `<attachment${attributes(attachment)}/>`));
  if (reply_to) lines.push(elementFor("reply-to", reply_to));
  lines.push(`</${name}>`);
  return lines.join("\n");
}

export const promptFor = (message) => elementFor("telegram-message", payloadFor(message));

export function piArgs(session) {
  // Sessions live in Pi's default directory for the Assistant workspace; --session-id keeps that cwd.
  return ["--mode", "json", "--approve", "--exclude-tools", "questionnaire",
    ...(session?.id ? ["--session-id", session.id] : ["--name", `telegram:${session.chat}`])];
}

// Pi stores sessions by working directory and --session-id resolves within the current one, so
// prefer the copy whose header records this workspace.
export function sessionFile(root, id, cwd) {
  if (!existsSync(root)) return;
  const suffix = `_${id}.jsonl`;
  const candidates = readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => path.join(entry.parentPath, entry.name));
  return candidates.find((file) => {
    try { return JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]).cwd === cwd; }
    catch { return false; }
  }) ?? candidates[0];
}

// One Pi process per message: the prompt goes to stdin and progress arrives as JSON events.
export class PiRun {
  constructor(child, onEvent = () => {}, killTimeoutMs = 5000) {
    this.child = child;
    this.killTimeoutMs = killTimeoutMs;
    let buffer = "";
    let finalError;
    let settled = false;
    let sessionStarted;
    this.session = new Promise((resolve) => { sessionStarted = resolve; });
    this.done = new Promise((resolve, reject) => {
      const receive = (event) => {
        if (event.type === "session") sessionStarted(event.id);
        if (event.type === "message_end" && event.message?.role === "assistant") {
          finalError = event.message.stopReason === "error" ? event.message.errorMessage || "Pi request failed" : undefined;
        }
        if (event.type === "agent_settled") {
          settled = true;
          if (finalError) reject(new Error(finalError));
          else resolve();
        }
        onEvent(event);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, "");
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          try { receive(JSON.parse(line)); }
          catch { reject(new Error("Invalid Pi JSON record")); this.stop(); }
        }
      });
      child.stdin.on("error", (error) => { reject(error); this.stop(); });
      child.on("error", reject);
      child.once("close", (code, signal) => {
        clearTimeout(this.killTimer);
        sessionStarted(undefined);
        if (this.stopped) resolve();
        else if (!settled) reject(new Error(`Pi exited (${signal || code})`));
      });
    });
    this.exited = new Promise((resolve) => child.once("close", resolve));
  }
  stop() {
    if (this.stopped) return this.exited;
    this.stopped = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), this.killTimeoutMs);
      this.child.kill("SIGTERM");
    }
    return this.exited;
  }
}

const truncate = (text, max = 56) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

// Credentials are usually passed as key=value or long literal tokens.
export function commandPreview(command) {
  return truncate(String(command).replace(/\s+/g, " ").trim()
    .replace(/(token|api[_-]?key|secret|password)\s*[=:]\s*\S+/gi, "$1=***")
    .replace(/[A-Za-z0-9_-]{32,}/g, "***"));
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
      if (["read", "edit", "write"].includes(name) && args.path) this.detail = `${name}: ${truncate(String(args.path))}`;
      else if (name === "bash" && args.command) this.detail = `$ ${commandPreview(args.command)}`;
      else this.detail = name;
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
  constructor({ stateFile, api, allowedUsers, createPi, sessionExists, log = console.error, progressDelay = 1000 }) {
    this.stateFile = stateFile;
    this.api = api;
    this.allowedUsers = new Set(allowedUsers);
    this.createPi = createPi;
    this.sessionExists = sessionExists;
    this.log = log;
    this.progressDelay = progressDelay;
    this.state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8"))
      : { offset: 0, sessions: {}, pending: [], running: {} };
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
  session(chat) {
    const saved = this.state.sessions[chat];
    if (saved?.id && this.sessionExists(saved.id)) return saved;
    if (saved) this.log(`Session ${saved.id} for chat ${chat} is missing; starting a new one`);
    return { chat };
  }
  async processChat(chat, active) {
    while (!this.closing && !active.stopped) {
      const index = this.state.pending.findIndex((message) => String(message.chat.id) === chat);
      if (index < 0) break;
      const [message] = this.state.pending.splice(index, 1);
      if (this.command(message) === "/new") {
        delete this.state.sessions[chat];
        this.save();
        await this.text(chat, "🆕 已开启新会话。后续消息会沿用它。").catch(this.log);
        continue;
      }
      this.state.running[chat] = message;
      this.save();
      const progress = new ProgressReporter(this.api, chat, this.log, "✨ Please wait…", this.progressDelay);
      const typing = setInterval(() => this.api("sendChatAction", { chat_id: chat, action: "typing" }).catch(this.log), 4500);
      try {
        await this.api("sendChatAction", { chat_id: chat, action: "typing" }).catch(this.log);
        if (active.stopped || this.closing) break;
        const status = new ProgressState();
        const run = this.createPi(chat, this.session(chat), promptFor(message), (event) => {
          const text = status.update(event);
          if (text) progress.update(text);
        });
        active.run = run;
        const id = await run.session;
        if (id) {
          this.state.sessions[chat] = { id };
          this.save();
        }
        // Assistant text is intentionally not forwarded. The agent sends replies through its skill.
        await run.done;
      } catch (error) {
        this.log(error);
        if (!this.closing && !active.stopped) await this.text(chat, "🔴 处理失败，不会自动重做。请重新发消息，或用 /logs 查看错误。").catch(this.log);
      } finally {
        active.run = undefined;
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
    await active?.run?.stop();
    await this.text(chat, "🛑 已停止当前任务，并取消排队消息。会话保留。");
  }
  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.active.values()].map((active) => active.run?.stop()));
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
  const encodedToken = encodeURIComponent(token);
  const log = (error) => console.error(`[${new Date().toISOString()}] ${String(error?.message || error)
    .replaceAll(token, "[REDACTED]").replaceAll(encodedToken, "[REDACTED]")}`);
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
  const agentDir = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "pi");
  const assistant = new Assistant({
    stateFile: path.join(stateDir, "state.json"), api, allowedUsers, log,
    sessionExists: (id) => sessionFile(path.join(agentDir, "sessions"), id, root) !== undefined,
    createPi: (chat, session, message, onEvent) => {
      const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TELEGRAM_DEFAULT_CHAT_ID: chat };
      for (const key of Object.keys(env)) if (key.startsWith("PI_SESSION_")) delete env[key];
      delete env.TELEGRAM_BOT_TOKEN;
      const child = spawn("pi", piArgs(session), { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text) => log(text.trim()));
      child.stdin.end(message);
      return new PiRun(child, onEvent);
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
