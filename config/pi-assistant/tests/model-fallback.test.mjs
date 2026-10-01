import assert from "node:assert/strict";
import test from "node:test";
import modelFallback from "../.pi/extensions/model-fallback.ts";

const model = (id, provider = "openai") => ({ provider, id });
const scoped = [model("opus", "claude-code"), model("astra"), model("sol")];

function setup({ unavailable = [] } = {}) {
  const handlers = {};
  const selected = [];
  const ctx = { model: model("sol"), scopedModels: scoped.map((model) => ({ model })) };
  modelFallback({
    on: (event, handler) => { handlers[event] = handler; },
    setModel: async (next) => {
      if (unavailable.includes(next.id)) return false;
      selected.push(next.id);
      ctx.model = next;
      return true;
    },
  });
  const failure = (outcome = "error", role = "assistant") => handlers.agent_before_settle({
    outcome, context: { contextEntries: [{ sourceEntry: { id: "user" }, messages: [{ role: "user" }] }, { sourceEntry: { id: "failed" }, messages: [{ role }] }] },
  }, ctx);
  return { handlers, selected, ctx, failure };
}

test("a failed run continues with the next scoped model without the failed reply", async () => {
  const { selected, failure } = setup();
  assert.deepEqual(await failure(), { entries: [{ type: "context_edit", targetId: "failed", replacement: null }], continue: true });
  assert.deepEqual(selected, ["opus"]);
});

test("each scoped model is tried once per run, skipping unavailable models", async () => {
  const { selected, failure } = setup({ unavailable: ["opus"] });
  assert.equal((await failure()).continue, true);
  assert.equal(await failure(), undefined);
  assert.deepEqual(selected, ["astra"]);
});

test("settling restores the initial model and resets attempts for the next message", async () => {
  const { handlers, selected, ctx, failure } = setup();
  await failure();
  await handlers.agent_settled();
  assert.equal(ctx.model.id, "sol");
  await failure();
  assert.deepEqual(selected, ["opus", "sol", "opus"]);
});

test("completed, aborted and non-assistant endings do not switch models", async () => {
  const { handlers, selected, failure } = setup();
  assert.equal(await failure("completed"), undefined);
  assert.equal(await failure("aborted"), undefined);
  assert.equal(await failure("error", "toolResult"), undefined);
  await handlers.agent_settled();
  assert.deepEqual(selected, []);
});
