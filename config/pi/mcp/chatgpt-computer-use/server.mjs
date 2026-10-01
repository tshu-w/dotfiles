import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Broker } from './broker.mjs';

export async function forwardApproval(server, params, signal) {
  if (params.mode !== 'form' || server.getClientCapabilities()?.elicitation?.form === undefined) {
    throw new Error(`Official approval cancelled: ${params.message || params.description || params.mode}. This MCP client cannot display the requested approval form. Use an MCP client that supports this approval form. No approval was granted; do not retry automatically.`);
  }
  return server.elicitInput({ mode: 'form', message: params.message, requestedSchema: params.requestedSchema, ...(params._meta ? { _meta: params._meta } : {}) }, { signal });
}

export function createBridge(options = {}) {
  const server = new Server({ name: 'chatgpt-computer-use-mcp', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Control macOS apps through official ChatGPT Computer Use. Prefer purpose-built APIs or CLIs. Call get_app_state before interacting with an app each assistant turn, and use fresh element indexes and screenshot coordinates. Calls are serialized. The official host runs in Full access and may automatically accept empty approval forms. Remaining approval requests require client form elicitation; unsupported requests are cancelled. Full access is not task-specific consent for destructive actions or sending sensitive data. Actions may have executed on cancellation or timeout; never retry automatically. Results preserve official text, images, structuredContent, isError, and metadata. Use program for composition.',
  });
  const broker = new Broker({ ...options, onElicitation: (params, signal) => forwardApproval(server, params, signal) });
  server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => broker.listTools(extra.signal));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try { return await broker.call(request.params.name, request.params.arguments || {}, extra.signal); }
    catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
  });
  server.onclose = () => { void broker.close().catch(error => { console.error(error.message); process.exitCode = 1; }); };
  return { server, broker };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, broker } = createBridge();
  let stopping;
  const stop = () => {
    stopping ||= (async () => { await broker.close(); await server.close(); })().catch(error => { console.error(error.message); process.exitCode = 1; });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await server.connect(new StdioServerTransport());
}
