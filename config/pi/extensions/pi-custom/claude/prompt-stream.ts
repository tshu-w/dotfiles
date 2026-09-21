// Adapted from pi-claude-bridge (MIT), copyright 2026 Eli Dickinson. See LICENSE.
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface PromptStream {
	stream: AsyncGenerator<SDKUserMessage>;
	
	push: (msg: SDKUserMessage) => Promise<void>;
	
	end: () => void;
	
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
		end: () => { done = true; kick(); },
		fail: (error) => {
			if (failure) return;
			failure = error;
			queue.splice(0).forEach((item) => item.reject(error));
			inflight?.reject(error);
			kick();
		},
	};
}

export function userMessage(content: SDKUserMessage["message"]["content"], priority?: SDKUserMessage["priority"]): SDKUserMessage {
	return {
		type: "user",
		message: { role: "user", content } as SDKUserMessage["message"],
		parent_tool_use_id: null,
		...(priority ? { priority } : {}),
	};
}
