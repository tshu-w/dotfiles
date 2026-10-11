const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { stripVTControlCharacters: stripAnsi } = require("node:util");

const prefix = dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const pkg = join(prefix, "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = require(join(pkg, "node_modules/jiti/lib/jiti.cjs"));
const jiti = createJiti(__filename, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": `${pkg}/dist/index.js`,
    "@earendil-works/pi-tui": `${pkg}/node_modules/@earendil-works/pi-tui/dist/index.js`,
  },
});

async function setup() {
  const { installTranscriptDisplay } = await jiti.import("../transcript-display.ts");
  const pi = await import(`${pkg}/dist/index.js`);
  const tui = await import(`${pkg}/node_modules/@earendil-works/pi-tui/dist/index.js`);
  const themes = await import(`${pkg}/dist/modes/interactive/theme/theme.js`);
  themes.initTheme("dark");
  const { KeybindingsManager } = await import(`${pkg}/dist/core/keybindings.js`);
  const keybindings = new KeybindingsManager();
  const previousKeybindings = tui.getKeybindings();
  tui.setKeybindings(keybindings);
  const prototype = {
    toggleToolOutputExpansion: pi.InteractiveMode.prototype.toggleToolOutputExpansion,
    renderInitialMessages() {},
    rebuildChatFromMessages() {},
  };
  const mode = Object.assign(Object.create(prototype), {
    chatContainer: new tui.Container(),
    loadedResourcesContainer: new tui.Container(),
    toolOutputExpanded: false,
    outputPad: 1,
    ui: { requestRender() {} },
    setToolsExpanded: pi.InteractiveMode.prototype.setToolsExpanded,
    showStatus: pi.InteractiveMode.prototype.showStatus,
  });
  const editor = new pi.CustomEditor(mode.ui, themes.getEditorTheme(), keybindings);
  editor.onAction("app.tools.expand", () => mode.toggleToolOutputExpansion());
  const restore = installTranscriptDisplay(prototype, () => themes.theme);
  return { ...pi, ...tui, mode, editor, keybindings, themes, restore() { restore(); tui.setKeybindings(previousKeybindings); } };
}

function message(content, stopReason = "toolUse") {
  return { role: "assistant", content, stopReason, timestamp: 1 };
}

test("Ctrl+O cycles native views and compact live tool runs without changing messages", async () => {
  const { mode, editor, keybindings, themes, restore, AssistantMessageComponent, ToolExecutionComponent, Text, visibleWidth, createReadToolDefinition } = await setup();
  try {
    const source = message([{ type: "thinking", thinking: "private reasoning" }, { type: "toolCall", id: "1", name: "read", arguments: {} }]);
    const original = structuredClone(source);
    const assistant = new AssistantMessageComponent(source);
    const tool = new ToolExecutionComponent("read", "1", { path: "secret-path" }, {}, createReadToolDefinition("/tmp"), mode.ui, "/tmp");
    mode.chatContainer.addChild(new Text("User question"));
    mode.chatContainer.addChild(assistant);
    mode.chatContainer.addChild(tool);
    mode.renderInitialMessages();
    assert.match(stripAnsi(mode.chatContainer.render(80).join("\n")), /1 tool call: read, ctrl\+o to expand/);
    const output = Array.from({ length: 30 }, (_, i) => `result line ${i}`).join("\n");
    tool.updateResult({ content: [{ type: "text", text: output }] });
    editor.handleInput("\x0f");
    assert.equal(mode.toolOutputExpanded, false);
    assert.match(mode.chatContainer.render(80).join("\n"), /secret-path/);
    assert.doesNotMatch(mode.chatContainer.render(80).join("\n"), /result line 29|tool call:|Tool output:/);
    tool.updateResult(undefined, true);
    const initial = mode.chatContainer.render(80);
    mode.rebuildChatFromMessages();
    assert.deepEqual(mode.chatContainer.render(80), initial, "rebuild preserves the selected view");
    tool.updateResult({ content: [{ type: "text", text: output }] });
    editor.handleInput("\x0f");
    assert.equal(mode.toolOutputExpanded, true);
    assert.match(mode.chatContainer.render(80).join("\n"), /result line 29/);
    assert.doesNotMatch(mode.chatContainer.render(80).join("\n"), /tool call:|Tool output:/);
    editor.handleInput("\x0f");
    let text = mode.chatContainer.render(80).join("\n");
    assert.match(text, /1 tool call: read/);
    assert.doesNotMatch(text, /private reasoning|secret-path|Thinking/);
    const second = new ToolExecutionComponent("read", "2", {}, {}, undefined, mode.ui, "/tmp");
    mode.chatContainer.addChild(new AssistantMessageComponent(message([{ type: "thinking", thinking: "more reasoning" }])));
    mode.chatContainer.addChild(second);
    mode.chatContainer.addChild(new ToolExecutionComponent("bash", "3", {}, {}, undefined, mode.ui, "/tmp"));
    tool.updateResult({ content: [{ type: "text", text: "hidden result" }] });
    text = mode.chatContainer.render(80).join("\n");
    assert.match(stripAnsi(text), /3 tool calls: read, bash, ctrl\+o to expand/);
    for (const appearance of ["light", "dark"]) {
      themes.initTheme(appearance);
      text = mode.chatContainer.render(80).join("\n");
      assert.ok(text.includes(themes.theme.fg("dim", "ctrl+o")));
      assert.notEqual(themes.theme.fg("dim", "ctrl+o"), themes.theme.fg("muted", "ctrl+o"));
    }
    keybindings.setUserBindings({ "app.tools.expand": "ctrl+y" });
    assert.match(stripAnsi(mode.chatContainer.render(80).join("\n")), /ctrl\+y to expand/);
    editor.handleInput("\x19");
    assert.equal(mode.toolOutputExpanded, false);
    editor.handleInput("\x19");
    assert.equal(mode.toolOutputExpanded, true);
    editor.handleInput("\x19");
    assert.equal(mode.chatContainer.children.length, 6);
    assert.equal((mode.chatContainer.render(80).join("\n").match(/tool calls?:/g) || []).length, 1);
    keybindings.setUserBindings({});
    assert.doesNotMatch(text, /hidden result|more reasoning/);
    assert.ok(mode.chatContainer.render(1).every(line => visibleWidth(line) <= 1));
    const reply = new AssistantMessageComponent(message([{ type: "text", text: "Partial reply" }], "pending"));
    mode.chatContainer.addChild(reply);
    assert.match(mode.chatContainer.render(80).join("\n"), /Partial reply/);
    reply.updateContent(message([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Final reply" }], "stop"), false);
    mode.chatContainer.addChild(new ToolExecutionComponent("read", "4", {}, {}, undefined, mode.ui, "/tmp"));
    text = mode.chatContainer.render(80).join("\n");
    assert.match(text, /Final reply/);
    assert.equal((text.match(/tool calls?:/g) || []).length, 2);
    mode.chatContainer.invalidate();
    for (const width of [8, 20, 80]) {
      for (const line of mode.chatContainer.render(width)) {
        assert.ok(visibleWidth(line) <= width, `width=${width}, line=${JSON.stringify(line)}`);
      }
    }
    assert.deepEqual(source, original);
    editor.handleInput("\x0f");
    assert.equal(mode.toolOutputExpanded, false);
    assert.match(mode.chatContainer.render(80).join("\n"), /private reasoning/);
    mode.chatContainer.children = [mode.chatContainer.children[0], assistant, tool];
    tool.updateResult(undefined, true);
    assert.deepEqual(mode.chatContainer.render(80), initial);
  } finally {
    restore();
  }
});

test("compact view keeps errors, supports rebuilt history, and restores on shutdown", async () => {
  const { mode, restore, AssistantMessageComponent, ToolExecutionComponent, Text } = await setup();
  const originalRender = mode.chatContainer.render;
  const originalMouse = mode.chatContainer.handleMouse;
  mode.rebuildChatFromMessages();
  mode.chatContainer.addChild(new ToolExecutionComponent("read", "1", {}, {}, undefined, mode.ui, "/tmp"));
  const failed = message([{ type: "thinking", thinking: "hidden" }], "error");
  failed.errorMessage = "Request failed";
  mode.chatContainer.addChild(new AssistantMessageComponent(failed));
  assert.match(mode.chatContainer.render(80).join("\n"), /Request failed/);
  mode.chatContainer.clear();
  mode.chatContainer.addChild(new Text("Another branch"));
  assert.doesNotMatch(mode.chatContainer.render(80).join("\n"), /tool call|Request failed/);
  restore();
  assert.equal(mode.chatContainer.render, originalRender);
  assert.equal(mode.chatContainer.handleMouse, originalMouse);
  mode.toggleToolOutputExpansion();
  assert.equal(mode.toolOutputExpanded, true);
});
