import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridge } from '../server.mjs';
import { Broker } from '../broker.mjs';
import { paths } from '../paths.mjs';

async function fixture(t, capabilities = {}) {
  const state = await mkdtemp(join(tmpdir(), 'pi-cu-test-'));
  const launch = async () => ({ state, codex: process.execPath, args: [fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))], client: '/unused-client' });
  const { server, broker } = createBridge({ launch });
  const client = new Client({ name: 'test', version: '1' }, { capabilities });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await broker.close(); assert.deepEqual(await readdir(state), []); await rm(state, { recursive: true }); });
  return { client, broker, state };
}

test('XDG empty values use home defaults and Pi config override is respected', () => {
  const defaults = paths({ XDG_CONFIG_HOME: '', XDG_STATE_HOME: '', PI_CODING_AGENT_DIR: '' }, '/home/test');
  assert.equal(defaults.pi, '/home/test/.config/pi');
  assert.equal(defaults.state, '/home/test/.local/state/pi/chatgpt-computer-use');
  const custom = paths({ XDG_CONFIG_HOME: '/config', XDG_STATE_HOME: '/state', PI_CODING_AGENT_DIR: '/pi' }, '/home/test');
  assert.equal(custom.pi, '/pi');
  assert.equal(custom.state, '/state/pi/chatgpt-computer-use');
  assert.match(custom.client, /^\/config\/codex\//);
});

test('MCP discovers ten tools, serializes calls, reuses the session, and preserves raw results', async t => {
  const { client } = await fixture(t);
  assert.equal((await client.listTools()).tools.length, 10);
  const results = await Promise.all([client.callTool({ name: 'list_apps', arguments: {} }), client.callTool({ name: 'get_app_state', arguments: {} })]);
  assert.deepEqual(results.map(r => r.structuredContent.count), [1, 2]);
  assert.deepEqual(results[0].content[1], { type: 'image', data: 'AA==', mimeType: 'image/png' });
  assert.deepEqual(results[0]._meta, { source: 'official' });
  assert.equal(results[0].isError, false);
});

test('missing approval UI cancels official approval and returns an actionable error', async t => {
  const { client } = await fixture(t);
  const result = await client.callTool({ name: 'get_app_state', arguments: { app: 'approval' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Official approval cancelled/);
  const next = await client.callTool({ name: 'list_apps', arguments: {} });
  assert.equal(next.structuredContent.count, 2);
});

test('approval-capable clients receive the official form and user response is forwarded', async t => {
  const { client } = await fixture(t, { elicitation: { form: {} } });
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async request => {
    assert.equal(request.params.message, 'Allow access to Test App?');
    prompts++;
    return { action: 'decline' };
  });
  const result = await client.callTool({ name: 'get_app_state', arguments: { app: 'approval' } });
  assert.equal(prompts, 1);
  assert.equal(result.content[0].text, 'decline');
  assert.equal(result.isError, true);
});

test('cancellation terminates the session without retrying an action', async t => {
  const { broker } = await fixture(t);
  await broker.listTools();
  const controller = new AbortController();
  const call = broker.call('get_app_state', { app: 'hang' }, controller.signal);
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(call, /cancelled/);
  await broker.close();
  await assert.rejects(broker.call('list_apps', {}), /closed/);
});

test('unexpected model activity fails closed', async t => {
  const { broker } = await fixture(t);
  await assert.rejects(broker.call('get_app_state', { app: 'model' }), /model-turn activity/);
  await broker.close();
});

test('stdio entrypoint works through a symlink without starting Computer Use during initialize', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-cu-entry-'));
  const entry = join(root, 'server.mjs');
  await symlink(fileURLToPath(new URL('../server.mjs', import.meta.url)), entry);
  const client = new Client({ name: 'entry-test', version: '1' }, { capabilities: {} });
  t.after(async () => { await client.close(); await rm(root, { recursive: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry] }));
  assert.equal(client.getServerVersion().name, 'chatgpt-computer-use-mcp');
});

test('closing during startup does not leave runtime state or spawn a broker', async () => {
  let release;
  const broker = new Broker({ launch: () => new Promise(resolve => { release = resolve; }) });
  const call = broker.listTools();
  await new Promise(resolve => setImmediate(resolve));
  const close = broker.close();
  release({});
  await assert.rejects(call, /closed/);
  await close;
});
