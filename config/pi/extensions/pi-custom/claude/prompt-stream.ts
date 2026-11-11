// Adapted from pi-claude-bridge (MIT), copyright 2026 Eli Dickinson. See LICENSE.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface PromptStream {
  stream: AsyncGenerator<SDKUserMessage>;
  push: (msg: SDKUserMessage) => Promise<void>;
  fail: (error: Error) => void;
}

export function makePromptStream(): PromptStream {
  type Item = { msg: SDKUserMessage; resolve: () => void; reject: (e: Error) => void };
  const queue: Item[] = [];
  let inflight: Item | null = null;
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;

  const kick = () => { wake?.(); wake = null; };

  async function* gen(): AsyncGenerator<SDKUserMessage> {
    try {
      while (true) {
        while (queue.length === 0 && !done && !failure) {
          await new Promise<void>((resolve) => { wake = resolve; });
        }
        if (failure) throw failure;
        const item = queue.shift();
        if (!item) return; // ended and drained
        inflight = item;
        try {
          yield item.msg;
          item.resolve();
        } finally {
          item.reject(new Error("prompt stream closed"));
          inflight = null;
        }
      }
    } finally {
      done = true;
    }
  }

  return {
    stream: gen(),
    push: (msg) => failure || done
      ? Promise.reject(failure ?? new Error("prompt stream closed"))
      : new Promise<void>((resolve, reject) => { queue.push({ msg, resolve, reject }); kick(); }),
    fail: (error) => {
      if (failure) return;
      failure = error;
      queue.splice(0).forEach((item) => item.reject(error));
      inflight?.reject(error);
      kick();
    },
  };
}

// Claude Code runs a prompt whose last text block starts with "/" as its own command, even with slash commands
// disabled; a leading zero-width space keeps Pi's text a message to the model.
const COMMAND = /^\s*\//;
function literal(content: SDKUserMessage["message"]["content"]): SDKUserMessage["message"]["content"] {
  if (typeof content === "string") return COMMAND.test(content) ? `\u200b${content}` : content;
  const last = content.at(-1);
  return last?.type === "text" && COMMAND.test(last.text) ? [...content.slice(0, -1), { ...last, text: `\u200b${last.text}` }] : content;
}

export function userMessage(content: SDKUserMessage["message"]["content"], priority?: SDKUserMessage["priority"]): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: literal(content) } as SDKUserMessage["message"],
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  };
}
