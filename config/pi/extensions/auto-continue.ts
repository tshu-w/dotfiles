/**
 * Auto-continue on streaming errors.
 *
 * When the last assistant message ends with stopReason "error",
 * automatically retriggers the LLM via a hidden custom message.
 * Gives up after MAX_CONSECUTIVE consecutive errors to avoid loops.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MAX_CONSECUTIVE = 3;

export default function autoContinueExtension(pi: ExtensionAPI): void {
	let consecutiveErrors = 0;

	pi.on("agent_end", async (event, ctx) => {
		const messages = event.messages as Array<{ role?: string; stopReason?: string }>;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "assistant") {
				if (messages[i]?.stopReason !== "error") {
					consecutiveErrors = 0;
					return;
				}
				break;
			}
		}

		consecutiveErrors++;
		if (consecutiveErrors > MAX_CONSECUTIVE) {
			consecutiveErrors = 0;
			ctx.ui.notify(`Auto-continue gave up after ${MAX_CONSECUTIVE} consecutive errors`, "warning");
			return;
		}

		ctx.ui.notify(`Streaming error, auto-retrying (${consecutiveErrors}/${MAX_CONSECUTIVE})`, "info");
		pi.sendMessage(
			{
				customType: "auto-continue",
				content: "[auto-retry: previous response lost due to streaming error before any content was generated. Respond to the original request as if the error did not occur.]",
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
