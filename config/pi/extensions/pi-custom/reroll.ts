import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MAX_EMPTY_REROLLS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requestMaxTokens(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const value = payload[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function outputWasClamped(
  payload: unknown,
  configuredMaxTokens: number | undefined,
): boolean {
  const effectiveMaxTokens = requestMaxTokens(payload);
  return (
    effectiveMaxTokens !== undefined &&
    configuredMaxTokens !== undefined &&
    effectiveMaxTokens < configuredMaxTokens
  );
}

function hasStructuredToolCall(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === "toolCall");
}

function hasVisibleText(message: AssistantMessage): boolean {
  return message.content.some(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
}

function asError(message: AssistantMessage, errorMessage: string): AssistantMessage {
  return { ...message, stopReason: "error", errorMessage };
}

export function classifyAssistantMessage(
  message: AssistantMessage,
  wasOutputClamped: boolean,
  emptyRerolls: number,
) {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { message, emptyRerolls };
  }
  if (hasStructuredToolCall(message)) {
    return { message, emptyRerolls: 0 };
  }
  if (message.stopReason === "length" && wasOutputClamped) {
    return {
      message: asError(
        message,
        "context_length_exceeded: output budget was clamped before a length-limited response",
      ),
      emptyRerolls: 0,
    };
  }
  if (hasVisibleText(message)) {
    return { message, emptyRerolls: 0 };
  }
  if (wasOutputClamped) {
    return {
      message: asError(
        message,
        "context_length_exceeded: output budget was clamped before an empty assistant response",
      ),
      emptyRerolls: 0,
    };
  }
  if (emptyRerolls >= MAX_EMPTY_REROLLS) {
    return { message, emptyRerolls };
  }
  return {
    message: asError(
      message,
      "stream ended before a terminal response event: empty assistant response",
    ),
    emptyRerolls: emptyRerolls + 1,
  };
}

export function registerReroll(pi: ExtensionAPI): void {
  let pendingOutputWasClamped = false;
  let emptyRerolls = 0;

  pi.on("before_provider_request", (event, ctx) => {
    pendingOutputWasClamped = outputWasClamped(event.payload, ctx.model?.maxTokens);
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "user") {
      pendingOutputWasClamped = false;
      emptyRerolls = 0;
      return;
    }
    if (event.message.role !== "assistant") return;

    const wasOutputClamped = pendingOutputWasClamped;
    pendingOutputWasClamped = false;
    const result = classifyAssistantMessage(
      event.message,
      wasOutputClamped,
      emptyRerolls,
    );
    emptyRerolls = result.emptyRerolls;
    if (result.message !== event.message) return { message: result.message };
  });
}
