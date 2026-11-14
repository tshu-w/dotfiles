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
  keybindings.setUserBindings({ "app.tools.expand": "ctrl+o" });
  const previousKeybindings = tui.getKeybindings();
  tui.setKeybindings(keybindings);
  const prototype = {
    toggleToolOutputExpansion: pi.InteractiveMode.prototype.toggleToolOutputExpansion,
    renderInitialMessages() {},
    rebuildChatFromMessages() {},
  };
  const statusMessages = [];
  const mode = Object.assign(Object.create(prototype), {
    chatContainer: new tui.Container(),
    loadedResourcesContainer: new tui.Container(),
    pendingMessagesContainer: new tui.Container(),
    toolOutputExpanded: false,
    outputPad: 1,
    session: { isStreaming: false },
    ui: { requestRender() {} },
    setToolsExpanded: pi.InteractiveMode.prototype.setToolsExpanded,
    showStatus: (message) => statusMessages.push(message),
  });
  const editor = new pi.CustomEditor(mode.ui, themes.getEditorTheme(), keybindings);
  editor.onAction("app.tools.expand", () => mode.toggleToolOutputExpansion());
  const restore = installTranscriptDisplay(prototype, () => themes.theme);
  let current = restore;
  return {
    ...pi, ...tui, mode, editor, keybindings, themes, statusMessages,
    reinstall() { current = installTranscriptDisplay(prototype, () => themes.theme); },
    uninstall() { current(); },
    restore() { current(); tui.setKeybindings(previousKeybindings); },
  };
}

function message(content, stopReason = "toolUse") {
  return { role: "assistant", content, stopReason, timestamp: 1 };
}

test("Ctrl+O cycles native views and compact live tool runs without changing messages", async () => {
  const { mode, editor, keybindings, statusMessages, restore, AssistantMessageComponent, ToolExecutionComponent, Text, visibleWidth, createReadToolDefinition } = await setup();
  try {
    const source = message([{ type: "thinking", thinking: "private reasoning" }, { type: "toolCall", id: "1", name: "read", arguments: {} }]);
    const original = structuredClone(source);
    const assistant = new AssistantMessageComponent(source);
    const tool = new ToolExecutionComponent("read", "1", { path: "secret-path" }, {}, createReadToolDefinition("/tmp"), mode.ui, "/tmp");
    mode.chatContainer.addChild(new Text("User question"));
    mode.chatContainer.addChild(assistant);
    mode.chatContainer.addChild(tool);
    mode.renderInitialMessages();
    assert.match(stripAnsi(mode.chatContainer.render(80).join("\n")), /1 step: read, ctrl\+o to expand/);
    const output = Array.from({ length: 30 }, (_, i) => `result line ${i}`).join("\n");
    tool.updateResult({ content: [{ type: "text", text: output }] });
    editor.handleInput("\x0f");
    assert.equal(mode.toolOutputExpanded, false);
    assert.match(mode.chatContainer.render(80).join("\n"), /secret-path/);
    assert.doesNotMatch(mode.chatContainer.render(80).join("\n"), /result line 29|\d+ steps?:/);
    tool.updateResult(undefined, true);
    const initial = mode.chatContainer.render(80);
    mode.rebuildChatFromMessages();
    assert.deepEqual(mode.chatContainer.render(80), initial, "rebuild preserves the selected view");
    tool.updateResult({ content: [{ type: "text", text: output }] });
    editor.handleInput("\x0f");
    assert.equal(mode.toolOutputExpanded, true);
    assert.match(mode.chatContainer.render(80).join("\n"), /result line 29/);
    assert.doesNotMatch(mode.chatContainer.render(80).join("\n"), /\d+ steps?:/);
    editor.handleInput("\x0f");
    let text = mode.chatContainer.render(80).join("\n");
    assert.match(stripAnsi(text), /1 step: read/);
    assert.doesNotMatch(text, /private reasoning|secret-path|Thinking/);
    const second = new ToolExecutionComponent("read", "2", {}, {}, undefined, mode.ui, "/tmp");
    mode.chatContainer.addChild(new AssistantMessageComponent(message([{ type: "thinking", thinking: "more reasoning" }])));
    mode.chatContainer.addChild(second);
    mode.chatContainer.addChild(new ToolExecutionComponent("bash", "3", {}, {}, undefined, mode.ui, "/tmp"));
    tool.updateResult({ content: [{ type: "text", text: "hidden result" }] });
    text = mode.chatContainer.render(80).join("\n");
    assert.match(stripAnsi(text), /3 steps: read, bash, ctrl\+o to expand/);
    keybindings.setUserBindings({ "app.tools.expand": "ctrl+y" });
    assert.match(stripAnsi(mode.chatContainer.render(80).join("\n")), /ctrl\+y to expand/);
    editor.handleInput("\x19");
    assert.equal(mode.toolOutputExpanded, false);
    editor.handleInput("\x19");
    assert.equal(mode.toolOutputExpanded, true);
    editor.handleInput("\x19");
    assert.equal(mode.chatContainer.children.length, 6);
    assert.equal((stripAnsi(mode.chatContainer.render(80).join("\n")).match(/\d+ steps?:/g) || []).length, 1);
    keybindings.setUserBindings({ "app.tools.expand": "ctrl+o" });
    assert.doesNotMatch(mode.chatContainer.render(80).join("\n"), /hidden result|more reasoning/);
    assert.ok(mode.chatContainer.render(1).every(line => visibleWidth(line) <= 1));
    // A narrow line drops tool names before the count and the hint.
    assert.match(stripAnsi(mode.chatContainer.render(60).join("\n")), /^ ─── Worked for 0s, 3 steps: read, …, ctrl\+o to expand ─── *$/m);
    assert.match(stripAnsi(mode.chatContainer.render(18).join("\n")), /^ ─── Worke\.\.\. ─── $/m);
    // The rule is indented by Pi's output pad.
    mode.outputPad = 3;
    assert.match(stripAnsi(mode.chatContainer.render(22).join("\n")), /^   ─── Worke\.\.\. ───   $/m);
    mode.outputPad = 1;
    const reply = new AssistantMessageComponent(message([{ type: "text", text: "Partial reply" }], "pending"));
    mode.chatContainer.addChild(reply);
    assert.match(mode.chatContainer.render(80).join("\n"), /Partial reply/);
    reply.updateContent(message([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Final reply" }], "stop"), false);
    mode.chatContainer.addChild(new ToolExecutionComponent("read", "4", {}, {}, undefined, mode.ui, "/tmp"));
    text = mode.chatContainer.render(80).join("\n");
    assert.match(text, /Final reply/);
    assert.equal((stripAnsi(text).match(/\d+ steps?:/g) || []).length, 2);
    mode.chatContainer.invalidate();
    for (const width of [8, 20, 80]) {
      for (const line of mode.chatContainer.render(width)) {
        assert.ok(visibleWidth(line) <= width, `width=${width}, line=${JSON.stringify(line)}`);
      }
    }
    assert.deepEqual(source, original);
    assert.deepEqual(statusMessages, [], "view toggles must not append status messages");
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

test("compact view summarizes custom messages but preserves user input across Ctrl+O modes", async () => {
  const { mode, editor, restore, BranchSummaryMessageComponent, CustomMessageComponent, UserMessageComponent, ToolExecutionComponent, Spacer, Text, visibleWidth, getMarkdownTheme } = await setup();
  const report = { customType: "pi-agents", content: "First observation\n\nHidden report detail", display: true, details: { sender: { name: "reviewer", id: "reviewer-1" } } };
  const original = structuredClone(report);
  const renderReport = (message, { expanded }) => new Text(`${expanded ? "Expanded detail" : `[worker] from ${message.details.sender.name}`}\n${message.content}`, 0, 0);
  const input = { customType: "worker", content: "Forwarded user input\n\nKeep this instruction", display: true, details: { user: true } };
  const renderInput = (message, { expanded, outputPad }) => expanded ? undefined : new UserMessageComponent(message.content, getMarkdownTheme(), outputPad);
  try {
    mode.chatContainer.addChild(new UserMessageComponent("Direct user input\n\nKeep this too", getMarkdownTheme()));
    mode.chatContainer.addChild(new CustomMessageComponent(report, renderReport));
    mode.chatContainer.addChild(new CustomMessageComponent(input, renderInput));
    mode.chatContainer.addChild(new CustomMessageComponent({ customType: "notice", content: [{ type: "text", text: "Notice preview\n\nHidden notice detail" }], display: true }));
    mode.chatContainer.addChild(new ToolExecutionComponent("read", "1", {}, {}, undefined, mode.ui, "/tmp"));
    mode.chatContainer.addChild(new Spacer(1));
    mode.chatContainer.addChild(new BranchSummaryMessageComponent({ role: "branchSummary", summary: "Hidden branch detail", fromId: "x", timestamp: 1 }));
    mode.renderInitialMessages();
    const render = () => stripAnsi(mode.chatContainer.render(120).join("\n"));
    const compact = render();
    // Without replies, custom messages and tool calls share one line before the summary.
    assert.match(compact, /Keep this instruction\s+─── 3 steps: read, messages, ctrl\+o to expand ─── *\n *\n ─── Branch summary, ctrl\+o to expand ─── *$/);
    assert.doesNotMatch(compact, /First observation|Notice preview|Hidden report detail|Hidden notice detail|Expanded detail|reviewer-1|Hidden branch detail/);
    assert.match(compact, /Direct user input/);
    assert.match(compact, /Keep this too/);
    assert.match(compact, /Forwarded user input/);
    assert.match(compact, /Keep this instruction/);
    editor.handleInput("\x0f");
    assert.match(render(), /Hidden report detail/);
    assert.match(render(), /\[worker\] from reviewer/);
    assert.match(render(), /Hidden notice detail/);
    assert.doesNotMatch(render(), /Expanded detail/);
    editor.handleInput("\x0f");
    assert.match(render(), /Expanded detail/);
    editor.handleInput("\x0f");
    assert.equal(render(), compact);
    mode.rebuildChatFromMessages();
    assert.doesNotMatch(render(), /Hidden report detail|Hidden notice detail/);
    const children = mode.chatContainer.children;
    mode.chatContainer.children = [children[1], children[3]];
    for (const width of [1, 8, 40]) {
      for (const line of mode.chatContainer.render(width)) {
        assert.ok(visibleWidth(line) <= width, `width=${width}, line=${JSON.stringify(line)}`);
      }
    }
    mode.chatContainer.children = children;
    assert.deepEqual(report, original);
    restore();
    assert.match(render(), /Hidden report detail/);
  } finally {
    restore();
  }
});

test("finished turns keep only their last text while the running turn folds steps as they come", async () => {
  const { mode, restore, AssistantMessageComponent, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent, Text, getMarkdownTheme } = await setup();
  try {
    const chat = mode.chatContainer;
    const tool = (name, id) => new ToolExecutionComponent(name, id, {}, {}, undefined, mode.ui, "/tmp");
    const done = (component) => { component.updateResult({ content: [{ type: "text", text: "ok" }] }); return component; };
    chat.addChild(new UserMessageComponent("First question", getMarkdownTheme(), 1, [], undefined, new Date(0).toISOString()));
    chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Looking first" }])));
    chat.addChild(done(tool("bash", "1")));
    chat.addChild(new AssistantMessageComponent({ ...message([{ type: "text", text: "First answer" }], "stop"), timestamp: 83000 }));
    chat.addChild(new UserMessageComponent("Second question", getMarkdownTheme(), 1, [], undefined, Date.now() - 42000));
    chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Checking now" }])));
    chat.addChild(done(tool("read", "2")));
    chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Almost there" }])));
    const running = tool("bash", "3");
    running.updateResult({ content: [{ type: "text", text: "partial output" }] }, true);
    chat.addChild(running);
    // A running tool folds right away, so fast commands don't flash.
    mode.renderInitialMessages();
    const render = () => stripAnsi(chat.render(80).join("\n"));
    mode.session.isStreaming = true;
    let text = render();
    assert.match(text, /─── Worked for 1m 23s, 1 step: bash, ctrl\+o to expand ───\s+First answer/);
    assert.doesNotMatch(text, /Looking first/);
    assert.match(text, /Checking now\s+─── 1 step: read, ctrl\+o to expand ───\s+Almost there/);
    assert.match(text, /Almost there\s+─── 1 step: bash, ctrl\+o to expand ─── *$/);
    assert.doesNotMatch(text, /partial output/);
    chat.addChild(new AssistantMessageComponent({ ...message([{ type: "text", text: "Second answer" }], "stop"), timestamp: Date.now() }));
    mode.session.isStreaming = false;
    text = render();
    assert.match(text, /Second question\s+─── Worked for 4[2-4]s, 2 steps: read, bash, ctrl\+o to expand ───\s+Second answer/);
    assert.doesNotMatch(text, /Checking now|Almost there|partial output/);
    // A notification after the agent stopped starts a turn; one mid-run does not. Both fold.
    const notice = (content) => new CustomMessageComponent({ customType: "pi-agents", content, display: true, details: {} },
      (message, { expanded }) => new Text(expanded ? `${message.content} detail` : message.content, 0, 0));
    chat.addChild(notice("Agent finished"));
    chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Notified once" }])));
    chat.addChild(notice("Steered notice"));
    chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Notified reply" }], "stop")));
    text = render();
    assert.match(text, /Second answer\s+─── Worked for 0s, 2 steps: messages, ctrl\+o to expand ───\s+Notified reply/);
    assert.doesNotMatch(text, /Agent finished|Notified once|Steered notice|detail/);
    // A turn that folds only texts still shows its line.
    chat.addChild(new UserMessageComponent("Third question", getMarkdownTheme(), 1, [], undefined, new Date(0).toISOString()));
    chat.addChild(new AssistantMessageComponent({ ...message([{ type: "text", text: "Steered text" }], "stop"), timestamp: 20000 }));
    chat.addChild(new AssistantMessageComponent({ ...message([{ type: "text", text: "Third answer" }], "stop"), timestamp: 30000 }));
    text = render();
    assert.match(text, /Third question\s+─── Worked for 30s, ctrl\+o to expand ───\s+Third answer/);
    assert.doesNotMatch(text, /Steered text/);
  } finally {
    restore();
  }
});

test("notifications without replies join the turn of the next reply", async () => {
  const { mode, restore, AssistantMessageComponent, CustomMessageComponent, UserMessageComponent, getMarkdownTheme } = await setup();
  try {
    const chat = mode.chatContainer;
    const notice = (timestamp) => new CustomMessageComponent({ customType: "pi-agents", content: "notice", display: true, details: {}, timestamp });
    // As in a real session: two notifications arrive before the reply to them.
    chat.addChild(new UserMessageComponent("Start agents", getMarkdownTheme()));
    chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Started" }], "stop")));
    chat.addChild(notice(0));
    chat.addChild(notice(1000));
    // A rebuilt reply ends when its entry was written.
    chat.addChild(new AssistantMessageComponent({ ...message([{ type: "text", text: "Both done" }], "stop"), timestamp: 2000 }, false, undefined, undefined, 1, [], "id", new Date(61000).toISOString()));
    chat.addChild(notice(70000));
    chat.addChild(new UserMessageComponent("Next", getMarkdownTheme(), 1, [], undefined, Date.now() - 5000));
    // A live reply ends when it is first seen finished.
    const live = new AssistantMessageComponent();
    live.updateContent({ ...message([{ type: "text", text: "Answer" }], "stop"), timestamp: Date.now() - 5000 }, true);
    chat.addChild(live);
    mode.renderInitialMessages();
    const render = () => stripAnsi(chat.render(80).join("\n"));
    render();
    live.updateContent({ ...message([{ type: "text", text: "Answer" }], "stop"), timestamp: Date.now() - 5000 }, false);
    chat.addChild(notice(80000));
    const text = render();
    assert.match(text, /Started\s+─── Worked for 1m 01s, 2 steps: messages, ctrl\+o to expand ─── *\s+Both done\s+Next\s+─── Worked for [5-7]s, 1 step: messages, ctrl\+o to expand ─── *\s+Answer\s+─── 1 step: messages, ctrl\+o to expand ─── *$/);
    assert.equal((text.match(/───/g) || []).length, 6);
  } finally {
    restore();
  }
});

test("compact view stays on across a reload that rebuilds the chat before reinstalling", async () => {
  const { mode, restore, reinstall, uninstall, ToolExecutionComponent } = await setup();
  try {
    mode.chatContainer.addChild(new ToolExecutionComponent("read", "1", {}, {}, undefined, mode.ui, "/tmp"));
    mode.renderInitialMessages();
    const compact = stripAnsi(mode.chatContainer.render(80).join("\n"));
    assert.match(compact, /1 step: read/);
    uninstall();
    mode.rebuildChatFromMessages();
    reinstall();
    assert.equal(stripAnsi(mode.chatContainer.render(80).join("\n")), compact);
    mode.rebuildChatFromMessages();
    assert.equal(stripAnsi(mode.chatContainer.render(80).join("\n")), compact);
  } finally {
    restore();
  }
});

test("compact view keeps errors, supports rebuilt history, and restores on shutdown", async () => {
  const { mode, restore, AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent, Text, getMarkdownTheme } = await setup();
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
  assert.doesNotMatch(mode.chatContainer.render(80).join("\n"), /step|Request failed/);
  // A failure its turn recovers from folds, its text and all.
  mode.chatContainer.clear();
  const partial = message([{ type: "text", text: "Partial answer" }], "error");
  partial.errorMessage = "Stream cut";
  mode.chatContainer.addChild(new AssistantMessageComponent(failed));
  mode.chatContainer.addChild(new AssistantMessageComponent(partial));
  mode.chatContainer.addChild(new ToolExecutionComponent("bash", "2", {}, {}, undefined, mode.ui, "/tmp"));
  mode.chatContainer.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Done" }], "stop")));
  const text = stripAnsi(mode.chatContainer.render(80).join("\n"));
  assert.match(text, /─── Worked for 0s, 1 step, 2 retries: bash, ctrl\+o to expand ───\s+Done/);
  assert.doesNotMatch(text, /Request failed|Stream cut|Partial answer/);
  mode.chatContainer.addChild(new UserMessageComponent("Next question", getMarkdownTheme()));
  mode.chatContainer.addChild(new AssistantMessageComponent(failed));
  assert.match(mode.chatContainer.render(80).join("\n"), /Request failed/);
  restore();
  assert.equal(mode.chatContainer.render, originalRender);
  assert.equal(mode.chatContainer.handleMouse, originalMouse);
  mode.toggleToolOutputExpansion();
  assert.equal(mode.toolOutputExpanded, true);
});
