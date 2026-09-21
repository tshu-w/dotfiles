// Adapted from pi-claude-bridge (MIT), copyright 2026 Eli Dickinson. See LICENSE.
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { Message as SessionMessage, ContentBlock, ToolResultBlock } from "cc-session-io";
const MCP_TOOL_PREFIX = "mcp__pi__";

export const PROVIDER_ID = "claude-code";


export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (normalized.startsWith(MCP_TOOL_PREFIX)) {
		throw new Error(`mapPiToolNameToSdk: "${name}" is already an SDK tool name — pi history holds pi tool names`);
	}
	
	return customToolNameToSdk?.get(name) ?? customToolNameToSdk?.get(normalized) ?? `${MCP_TOOL_PREFIX}${name}`;
}

export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

function toolResultContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | ContentBlock[] {
	if (typeof content === "string" || !Array.isArray(content)) return messageContentToText(content) || "";
	const images = content.filter((b) => b.type === "image" && b.data && b.mimeType);
	if (!images.length) return messageContentToText(content) || "";
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) {
			blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		} else if (block.type !== "text" && block.type !== "image") {
			blocks.push({ type: "text", text: `[${block.type}]` });
		}
	}
	return blocks;
}

export type DroppedContent = {
	thinking: number;
	abortedTurns: number;
	providers: Set<string>;
	other: Map<string, number>;
};

export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk?: Map<string, string>,
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string>; dropped: DroppedContent } {
	const anthropicMessages: SessionMessage[] = [];
	const sanitizedIds = new Map<string, string>();
	const dropped: DroppedContent = { thinking: 0, abortedTurns: 0, providers: new Set(), other: new Map() };
	let turnResults: { role: "user"; content: ToolResultBlock[] } | null = null;
	let turnAssistantIdx: number | null = null;

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				anthropicMessages.push({ role: "user", content: msg.content || "[empty]" });
			} else if (Array.isArray(msg.content)) {
				const parts: ContentBlock[] = [];
				for (const block of msg.content) {
					if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
					else if (block.type === "image" && block.data && block.mimeType) {
						parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
					}
				}
				anthropicMessages.push({ role: "user", content: parts.length ? parts : "[image]" });
			} else {
				anthropicMessages.push({ role: "user", content: "[empty]" });
			}
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks: ContentBlock[] = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const sig = block.thinkingSignature;
					if (msg.provider === PROVIDER_ID && sig) {
						blocks.push(block.redacted
							? { type: "redacted_thinking", data: sig } as unknown as ContentBlock
							: { type: "thinking", thinking: block.thinking ?? "", signature: sig });
					} else {
						dropped.thinking++;
						dropped.providers.add(msg.provider ?? "unknown");
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				} else {
					dropped.other.set(block.type, (dropped.other.get(block.type) ?? 0) + 1);
				}
			}
			if (!content.length) { dropped.abortedTurns++; continue; }
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			turnResults = null;
			turnAssistantIdx = anthropicMessages.length;
			anthropicMessages.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			const block: ToolResultBlock = { type: "tool_result", tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds), content: toolResultContent(msg.content), is_error: msg.isError };
			if (turnResults) {
				turnResults.content.push(block);
			} else {
				turnResults = { role: "user", content: [block] };
				anthropicMessages.splice(turnAssistantIdx === null ? anthropicMessages.length : turnAssistantIdx + 1, 0, turnResults);
			}
		}
	}

	return { anthropicMessages, sanitizedIds, dropped };
}
