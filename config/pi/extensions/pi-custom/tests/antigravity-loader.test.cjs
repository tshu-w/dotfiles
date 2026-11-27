const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

test("real CLI and shared-runtime child load Antigravity without model calls or subpath aliases", { timeout: 20000 }, t => {
  const root = mkdtempSync(join(tmpdir(), "pi-agy-loader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], checkForUpdates: false }));
  const marker = join(root, "result.json");
  const custom = realpathSync(join(__dirname, "../index.ts"));
  const fixture = join(root, "offline.ts");
  writeFileSync(fixture, `
import { writeFileSync } from "node:fs";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
export default function(pi) {
  // Owned Agents bridge their owner's MCP tools instead of connecting servers.
  pi.on("mcp_servers_change", () => {});
  let calls = 0;
  pi.registerProvider("loader-offline", {
    api: "loader-offline", baseUrl: "http://fixture.invalid", apiKey: "fixture",
    models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 10 }],
    streamSimple() { calls++; throw new Error("Model calls are forbidden in loader validation"); },
  });
  pi.on("session_start", async (_event, ctx) => {
    const settingsManager = SettingsManager.inMemory({});
    const resourceLoader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: ${JSON.stringify(agentDir)},
      settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: ["builtin:mcp", ${JSON.stringify(custom)}],
      extensionFactories: [{ name: "mcp", builtin: true, factory: child => child.on("mcp_servers_change", () => {}) }] });
    await resourceLoader.reload();
    const loadErrors = resourceLoader.getExtensions().errors;
    if (loadErrors.length) throw new Error("Child extension loading failed: " + loadErrors.map(error => error.error).join("; "));
    const { session } = await createAgentSession({ cwd: ctx.cwd, agentDir: ${JSON.stringify(agentDir)},
      modelRuntime: ctx.modelRegistry.runtime, model: ctx.model, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(ctx.cwd), tools: [],
      sessionStartEvent: { type: "session_start", reason: "new" } });
    const errors = [];
    try {
      await session.bindExtensions({ mode: "print", onError: error => errors.push(error.error) });
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ childLoaded: true, model: session.model?.provider, modelCalls: calls, errors }));
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });
}
`);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache") };
  for (const key of Object.keys(env)) if (key.startsWith("PI_AGENTS_")) delete env[key];
  const cli = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  const stdout = execFileSync(cli, ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "-e", custom, "-e", fixture, "--provider", "loader-offline", "--model", "offline"], {
    cwd: root, env, encoding: "utf8", input: JSON.stringify({ id: "loader", type: "get_state" }) + "\n", timeout: 15000,
  });
  const response = stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)).find(event => event.id === "loader");
  assert.equal(response?.success, true);
  assert.equal(response.data.model.provider, "loader-offline");
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { childLoaded: true, model: "loader-offline", modelCalls: 0, errors: [] });
});
