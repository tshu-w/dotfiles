import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
) {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { message };
  }
  if (hasStructuredToolCall(message)) {
    return { message };
  }
  if (message.stopReason === "length" && wasOutputClamped) {
    return {
      message: asError(
        message,
        "context_length_exceeded: output budget was clamped before a length-limited response",
      ),
    };
  }
  if (hasVisibleText(message)) {
    return { message };
  }
  if (wasOutputClamped) {
    return {
      message: asError(
        message,
        "context_length_exceeded: output budget was clamped before an empty assistant response",
      ),
    };
  }
  return { message };
}

export function registerReroll(pi: ExtensionAPI): void {
  let pendingOutputWasClamped = false;

  pi.on("before_provider_request", (event, ctx) => {
    pendingOutputWasClamped = outputWasClamped(event.payload, ctx.model?.maxTokens);
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "user") {
      pendingOutputWasClamped = false;
      return;
    }
    if (event.message.role !== "assistant") return;

    const wasOutputClamped = pendingOutputWasClamped;
    pendingOutputWasClamped = false;
    const result = classifyAssistantMessage(
      event.message,
      wasOutputClamped,
    );
    if (result.message !== event.message) return { message: result.message };
  });
}
