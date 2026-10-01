#!/usr/bin/env node
import { createInterface } from 'node:readline';
const methods = ['list_apps', 'get_app_state', 'click', 'drag', 'scroll', 'type_text', 'press_key', 'set_value', 'select_text', 'perform_secondary_action'];
let count = 0;
let active = false;
let waiting;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const result = (id, data) => send({ id, result: data });
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method && m.id === 'approval') {
    result(waiting, { content: [{ type: 'text', text: m.result.action }], isError: m.result.action !== 'accept' });
    active = false;
  } else if (m.method === 'initialize') result(m.id, {});
  else if (m.method === 'thread/start') {
    if (m.params.approvalPolicy !== 'never' || m.params.sandbox !== 'danger-full-access' || m.params.ephemeral !== true) send({ id: m.id, error: { message: 'Expected ephemeral Full access thread' } });
    else result(m.id, { thread: { id: 'test-thread' } });
  }
  else if (m.method === 'mcpServerStatus/list') result(m.id, { data: [{ name: 'computer-use', tools: Object.fromEntries(methods.map(name => [name, { name, description: name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: name === 'list_apps' } }])) }] });
  else if (m.method === 'mcpServer/tool/call') {
    if (active) { send({ id: m.id, error: { message: 'Concurrent call' } }); return; }
    active = true;
    count++;
    if (m.params.arguments.app === 'approval') {
      waiting = m.id;
      send({ id: 'approval', method: 'mcpServer/elicitation/request', params: { mode: 'form', message: 'Allow access to Test App?', requestedSchema: { type: 'object', properties: {} } } });
    } else if (m.params.arguments.app === 'hang') {
      // Wait for cancellation or shutdown.
    } else if (m.params.arguments.app === 'model') send({ method: 'turn/started' });
    else setTimeout(() => {
      result(m.id, { content: [{ type: 'text', text: 'state' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }], structuredContent: { count }, isError: false, _meta: { source: 'official' } });
      active = false;
    }, 25);
  }
});
