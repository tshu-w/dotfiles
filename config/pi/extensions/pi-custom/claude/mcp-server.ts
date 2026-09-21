// Adapted from pi-claude-bridge (MIT), copyright 2026 Eli Dickinson. See LICENSE.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpResult } from "./extract-tool-results.js";

const TOOL_USE_ID_META = "claudecode/toolUseId";

export interface McpToolDef {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: (toolCallId: string) => Promise<McpResult>;
}

function assertObjectSchema(tool: McpToolDef): void {
	const schema = tool.inputSchema as Record<string, unknown> | undefined;
	if (!schema || schema.type !== "object") {
		throw new Error(`${tool.name}: MCP tool parameters must be an object schema, got ${JSON.stringify(schema)}`);
	}
}

export function createToolServer(name: string, tools: McpToolDef[]) {
	const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	for (const tool of tools) assertObjectSchema(tool);

	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema as Record<string, unknown>,
		})),
	}));

	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = byName.get(request.params.name);
		if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
		const toolCallId = request.params._meta?.[TOOL_USE_ID_META];
		if (typeof toolCallId !== "string") {
			throw new Error(`${tool.name}: tools/call is missing _meta["${TOOL_USE_ID_META}"] — cannot pair the result with its tool call`);
		}
		const { content, isError } = await tool.handler(toolCallId);
		return { content, isError };
	});

	return { type: "sdk" as const, name, instance: server };
}
