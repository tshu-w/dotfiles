const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");

const PI_PREFIX = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const PI_PACKAGE = join(PI_PREFIX, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(PI_PACKAGE, "node_modules/jiti/lib/jiti.cjs"));

test("the uv guard blocks pip, poetry and bare python with a uv suggestion", async () => {
  const { registerUvGuard } = await createJiti(__filename, { interopDefault: true }).import("../guards.ts");
  let handler;
  registerUvGuard({ on: (_event, fn) => { handler = fn; } });
  const run = (command, toolName = "bash") => handler({ toolName, input: { command } });
  for (const [command, suggestion] of [
    ["pip install x", /uv run --with PACKAGE python/],
    ["cd a && python3 -m venv .venv", /uv venv/],
    ["python script.py", /uv run python/],
    ["poetry add x", /uv.*add/],
  ]) {
    const blocked = await run(command);
    assert.equal(blocked.block, true, command);
    assert.match(blocked.reason, suggestion);
  }
  assert.equal(await run("uv run python x.py"), undefined);
  assert.equal(await run("   "), undefined);
  assert.equal(await run("pip install x", "read"), undefined);
});
