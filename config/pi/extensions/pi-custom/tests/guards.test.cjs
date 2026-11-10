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
  assert.deepEqual(await run("pip install x"), {
    block: true,
    reason: "pip is blocked. Use uv instead:\n\n  To install a package for a script: uv run --with PACKAGE python script.py\n  To add a dependency to the project: uv add PACKAGE",
  });
  assert.equal((await run("cd a && python3 -m venv .venv")).reason, "python3 -m venv is blocked. Use uv instead:\n\n  To create a virtual environment: uv venv");
  assert.equal((await run("python script.py")).reason, "python should be run via uv. Use: uv run python <args>");
  assert.equal((await run("poetry add x")).reason, "poetry is blocked. Use uv instead of poetry (uv init, uv add, uv sync, uv run)");
  assert.equal(await run("uv run python x.py"), undefined);
  assert.equal(await run("   "), undefined);
  assert.equal(await run("pip install x", "read"), undefined);
});
