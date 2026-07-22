const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

async function main() {
  const jiti = createJiti(__filename, {
    interopDefault: true,
    alias: { "@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js` },
  });
  const extension = await jiti.import("../index.ts");
  const handlers = new Map();
  extension.default({ on(name, handler) { handlers.set(name, handler); } });

  const toolResult = handlers.get("tool_result");
  const toolCall = handlers.get("tool_call");
  assert.ok(toolResult && toolCall);

  const code = "def login(token: str, password: Optional[str]) -> bool:";
  assert.equal(await toolResult({ toolName: "read", input: { path: "main.py" }, content: [{ type: "text", text: code }] }), undefined);

  const configResult = await toolResult({
    toolName: "read",
    input: { path: "config.yaml" },
    content: [{ type: "text", text: "password: example-value" }],
  });
  assert.equal(configResult.content[0].text, "password: [REDACTED]");
  assert.match(configResult.content[1].text, /Do not copy \[REDACTED\]/);

  const envResult = await toolResult({
    toolName: "bash",
    input: { command: "env" },
    content: [{ type: "text", text: "OPENAI_API_KEY=example-value" }],
  });
  assert.equal(envResult.content[0].text, "OPENAI_API_KEY=[REDACTED]");

  const blocked = await toolCall(
    { toolName: "read", input: { path: "/Users/example/.netrc" } },
    { hasUI: false, ui: { notify() {} } },
  );
  assert.deepEqual(blocked, { block: true, reason: "Sensitive file (.netrc)" });

  console.log("secret-guard integration: 4 cases passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
