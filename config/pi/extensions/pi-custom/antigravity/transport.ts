import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const AGENT_DEFINITION = readFileSync(new URL("./agent.md", import.meta.url), "utf8");

export function isAuthenticationRequired(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === -32000;
}

export interface AcpTool {
  name: string;
  description: string;
  parameters: any;
}

export interface AcpCallbacks {
  update(params: any): void;
  tool(name: string, args: any): Promise<{ content: any[]; isError?: boolean }>;
}

export interface AcpRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

type PendingRequest = {
  method: string;
  sessionId?: string;
  resolve(value: any): void;
  reject(error: Error): void;
  timeoutMs: number;
  toolWaits: number;
  sent?: boolean;
  cancelling?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  removeAbort?(): void;
};

export async function createAcpConnection(cwd: string, callbacks: AcpCallbacks, tools: AcpTool[] = [], overrides?: Record<string, string>, signal?: AbortSignal, profile?: { geminiDir: string; historyTarget?: true }) {
  signal?.throwIfAborted();
  const env = { ...process.env, ...overrides };
  const geminiDir = resolve(cwd, profile?.geminiDir || env.GEMINI_HOME || join(env.HOME || homedir(), ".gemini"));
  const agentPath = join(geminiDir, "config", "agents", "pi", "agent.md");
  mkdirSync(dirname(agentPath), { recursive: true, mode: 0o700 });
  try { writeFileSync(agentPath, AGENT_DEFINITION, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (readFileSync(agentPath, "utf8") !== AGENT_DEFINITION) throw new Error(`Existing Antigravity agent conflicts with the Pi bridge: ${agentPath}`);
  }
  const token = `Bearer ${randomBytes(32).toString("hex")}`;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const active = new Set<Server>();
  let host = "";
  const http = createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== token.length || !timingSafeEqual(auth, Buffer.from(token))) {
      res.writeHead(401).end();
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const server = new Server({ name: "pi", version: "1.0.0" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [host],
      allowedOrigins: [`http://${host}`],
    });
    active.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = byName.get(request.params.name);
      if (!tool) throw new Error("Unknown Pi tool");
      const prompts = [...pending.values()].filter((entry) => entry.method === "session/prompt");
      for (const entry of prompts) { entry.toolWaits++; watch(entry); }
      try {
        return await callbacks.tool(tool.name, request.params.arguments ?? {});
      } finally {
        for (const entry of prompts) { entry.toolWaits--; watch(entry); }
      }
    });
    const cleanup = () => {
      active.delete(server);
      void server.close().catch(() => {});
    };
    res.once("close", cleanup);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
      cleanup();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => { http.removeListener("error", reject); resolve(); });
  });
  if (signal?.aborted) {
    http.close();
    signal.throwIfAborted();
  }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("ACP MCP listener failed");
  host = `127.0.0.1:${address.port}`;
  const mcpServer = { type: "http" as const, name: "pi", url: `http://${host}/mcp`, headers: [{ name: "Authorization", value: token }] };
  // Only empty-target creation keeps the writer in the child we can await.
  // Normal sessions need the per-session worker's HTTP MCP support.
  const child = spawn(env.AGY_ACP_BIN || "agy", ["acp", ...(profile?.historyTarget ? [] : ["--process-per-session"]),
    ...(profile ? ["--gemini-dir", profile.geminiDir] : []),
    "--disable-telemetry", "--include-default-customizations=false", "--agent", "pi"], {
    cwd, env, stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  const stopped = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let closed = false;
  let nextId = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, PendingRequest>();

  function watch(entry: PendingRequest) {
    if (entry.cancelling) return;
    clearTimeout(entry.timer);
    if (closed || ![...pending.values()].includes(entry) || !entry.timeoutMs || entry.toolWaits) return;
    entry.timer = setTimeout(() => close(new Error(`ACP request timed out: ${entry.method}`)), entry.timeoutMs);
  }

  // Prompt timeouts measure silence, excluding Pi's tool/approval gap; never total wall time.
  function setPromptWatchdog(sessionId: string, options: { timeoutMs?: number }) {
    for (const entry of pending.values()) {
      if (entry.method !== "session/prompt" || entry.sessionId !== sessionId) continue;
      entry.timeoutMs = options.timeoutMs ?? 600_000;
      watch(entry);
    }
  }

  function close(error = new Error("ACP connection closed")) {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.removeAbort?.();
      entry.reject(entry.method === "session/prompt" && entry.sent ? new DOMException(error.message, "AbortError") : error);
    }
    pending.clear();
    lines.close();
    child.stdin.destroy();
    child.stdout.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref();
    }
    for (const server of active) void server.close().catch(() => {});
    active.clear();
    http.close();
    http.closeAllConnections();
  }

  function send(message: any) {
    if (closed) throw new Error("ACP connection closed");
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) close(new Error("ACP write failed")); });
  }

  function cancel(sessionId: string) {
    const entry = [...pending.values()].find(entry => entry.method === "session/prompt" && entry.sessionId === sessionId);
    if (!entry) throw new Error("Antigravity has no active prompt to cancel");
    send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    entry.cancelling = true;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => close(new Error("ACP cancellation timed out")), 30_000);
  }

  function request(method: string, params: any, options: AcpRequestOptions = {}): Promise<any> {
    if (closed) return Promise.reject(new Error("ACP connection closed"));
    if (options.signal?.aborted) return Promise.reject(new Error("ACP request aborted"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const entry: PendingRequest = {
        method, sessionId: params?.sessionId, resolve, reject,
        timeoutMs: options.timeoutMs ?? (method === "session/prompt" ? 600_000 : 30_000),
        toolWaits: 0,
      };
      pending.set(id, entry);
      const abort = () => close(new Error("ACP request aborted"));
      options.signal?.addEventListener("abort", abort, { once: true });
      entry.removeAbort = () => options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) { abort(); return; }
      watch(entry);
      try {
        send({ jsonrpc: "2.0", id, method, params });
        entry.sent = true;
      } catch { close(new Error("ACP write failed")); }
    });
  }

  child.on("error", () => close(new Error("Unable to start agy ACP; check the agy executable")));
  child.stdin.on("error", () => close(new Error("ACP input failed")));
  child.stdout.on("error", () => close(new Error("ACP output failed")));
  child.on("exit", (code, signal) => {
    clearTimeout(killTimer);
    close(new Error(`agy ACP exited (${signal ?? code})`));
    clearTimeout(killTimer);
  });
  lines.on("close", () => { if (!closed) close(new Error("ACP output closed")); });
  lines.on("line", (line) => {
    if (closed) return;
    try {
      const message = JSON.parse(line);
      if (!message || message.jsonrpc !== "2.0") throw new Error("Invalid ACP message");
      if (message.method) {
        if (message.id !== undefined) {
          if (message.method === "session/request_permission") {
            const params = message.params;
            const name = params?.toolCall?.name;
            const activePrompt = typeof params?.sessionId === "string" && [...pending.values()].some(
              (entry) => entry.method === "session/prompt" && entry.sessionId === params.sessionId,
            );
            // agy supplies the canonical name alongside the ACP display title.
            // Pi's tool pipeline still owns execution, guards and user approval.
            const ownedTool = typeof name === "string" && name.startsWith("mcp_pi_") && byName.has(name.slice("mcp_pi_".length));
            const allow = activePrompt && ownedTool && params.options?.find((option: any) => option.kind === "allow_once" && typeof option.optionId === "string");
            send({ jsonrpc: "2.0", id: message.id, result: { outcome: allow
              ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } } });
          } else {
            send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client operation denied" } });
          }
        } else if (message.method === "session/update") {
          for (const entry of pending.values()) {
            if (entry.method === "session/prompt" && entry.sessionId === message.params?.sessionId) watch(entry);
          }
          callbacks.update(message.params);
        }
      } else {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.removeAbort?.();
        if (message.error) {
          const rawCode = message.error.code;
          const code = Number.isSafeInteger(rawCode) || (typeof rawCode === "string" && /^-?\d{1,16}$/.test(rawCode)) ? rawCode : undefined;
          entry.reject(Object.assign(new Error(isAuthenticationRequired({ code })
            ? "Antigravity is not signed in. Run agy to sign in."
            : code === undefined ? "ACP request failed" : `ACP request failed (${code})`), { code }));
        } else entry.resolve(message.result);
      }
    } catch { close(new Error("Invalid ACP message or update callback failed")); }
  });

  const abort = () => close(new Error("Antigravity startup aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const initialized = await request("initialize", {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "pi", version: "1.0.0" },
    });
    return { request, cancel, setPromptWatchdog, close: () => { close(); return stopped; }, get closed() { return closed; }, mcpServer, initialized };
  } catch (error) {
    close();
    await stopped;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
