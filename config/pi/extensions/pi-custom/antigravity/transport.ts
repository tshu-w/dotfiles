import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
  timer?: ReturnType<typeof setTimeout>;
  removeAbort?(): void;
};

export async function createAcpConnection(cwd: string, callbacks: AcpCallbacks, tools: AcpTool[] = [], overrides?: Record<string, string>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const token = `Bearer ${randomBytes(32).toString("hex")}`;
  const byName = new Map(tools.map((tool) => [`pi_${tool.name}`, tool]));
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
    const server = new Server({ name: "pi-bridge", version: "1.0.0" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [host],
      allowedOrigins: [`http://${host}`],
    });
    active.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({ name: `pi_${tool.name}`, description: tool.description, inputSchema: tool.parameters })),
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
  const mcpServer = { type: "http" as const, name: "pi-bridge", url: `http://${host}/mcp`, headers: [{ name: "Authorization", value: token }] };
  const env = { ...process.env, ...overrides };
  const child = spawn(env.AGY_ACP_BIN || "agy", ["acp", "--disable-telemetry", "--include-default-customizations=false"], {
    cwd, env, stdio: ["pipe", "pipe", "ignore"],
  });
  const lines = createInterface({ input: child.stdout });
  let closed = false;
  let nextId = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, PendingRequest>();

  function watch(entry: PendingRequest) {
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
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.removeAbort?.(); entry.reject(error); }
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
      try { send({ jsonrpc: "2.0", id, method, params }); }
      catch { close(new Error("ACP write failed")); }
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
            const ownedTool = typeof name === "string" && name.startsWith("mcp_pi-bridge_") && byName.has(name.slice("mcp_pi-bridge_".length));
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
        if (message.error) entry.reject(new Error(message.error.code === -32000
          ? "agy ACP rejected the request: authentication required (-32000); cached sign-in was not accepted by this process"
          : `ACP request failed (${message.error.code})`));
        else entry.resolve(message.result);
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
    return { request, setPromptWatchdog, close: () => close(), mcpServer, initialized };
  } catch (error) {
    close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
