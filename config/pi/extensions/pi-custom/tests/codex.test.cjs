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
    alias: {
      "@earendil-works/pi-coding-agent": `${PI_PACKAGE}/dist/index.js`,
      "@earendil-works/pi-ai": `${PI_PACKAGE}/node_modules/@earendil-works/pi-ai/dist/index.js`,
    },
  });
  const codex = await jiti.import("../codex.ts");

  const handlers = new Map();
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  const model = { provider: "openai-codex", id: "gpt-5.6", api: "openai-codex-responses" };
  const ui = { setStatus() {}, notify() {} };
  const control = codex.registerCodex(pi, {}, { fast: true });
  for (const handler of handlers.get("session_start")) handler({ reason: "new" }, { model, ui });
  const [fast, verbosity] = handlers.get("before_provider_request");

  // Fast mode asks the openai-codex provider for the priority service tier.
  assert.equal(control.isActive(), true);
  assert.deepEqual(fast({ payload: { model: "gpt-5.6" } }), { model: "gpt-5.6", service_tier: "priority" });
  control.setDesired(false);
  assert.equal(fast({ payload: { model: "gpt-5.6" } }), undefined);

  // OpenAI Responses requests ask for low verbosity unless they set one.
  assert.equal(verbosity({ payload: { model: "gpt-5.6" } }), undefined);
  for (const handler of handlers.get("model_select")) handler({ model: { ...model, provider: "openai", api: "openai-responses" } }, { ui });
  assert.deepEqual(verbosity({ payload: { model: "gpt-5.6", text: { format: { type: "text" } } } }), { model: "gpt-5.6", text: { format: { type: "text" }, verbosity: "low" } });
  assert.equal(verbosity({ payload: { text: { verbosity: "high" } } }), undefined);
  control.setDesired(true);
  assert.equal(fast({ payload: { model: "gpt-5.6" } }), undefined, "fast mode applies only to openai-codex");

  console.log("pi-custom: codex request tweaks verified");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
