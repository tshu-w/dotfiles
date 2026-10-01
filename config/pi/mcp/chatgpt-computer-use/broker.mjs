import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { paths } from './paths.mjs';

export const METHODS = ['list_apps', 'get_app_state', 'click', 'drag', 'scroll', 'type_text', 'press_key', 'set_value', 'select_text', 'perform_secondary_action'];

function verify(file) {
  for (const args of [['--verify', '--strict', file], ['-dv', '--verbose=2', file]]) {
    const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8', timeout: 10000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Signature verification failed: ${file}`);
    if (args[0] === '-dv' && !/^TeamIdentifier=2DC432GLL2$/m.test(result.stderr)) throw new Error(`Not signed by OpenAI: ${file}`);
  }
}

async function officialPaths() {
  const resolved = paths();
  for (const key of ['codex', 'client']) {
    resolved[key] = await realpath(resolved[key]);
    verify(resolved[key]);
  }
  return resolved;
}

export class Broker {
  constructor({ launch = officialPaths, onElicitation } = {}) {
    this.launch = launch;
    this.onElicitation = onElicitation;
    this.pending = new Map();
    this.nextId = 0;
    this.queue = Promise.resolve();
  }

  run(operation, signal) {
    const result = this.queue.then(async () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error('Computer Use bridge is closed');
      if (this.failure) throw this.failure;
      const abort = () => this.fail(new Error('Computer Use cancelled; an action may already have executed. Do not retry automatically.'));
      signal?.addEventListener('abort', abort, { once: true });
      this.signal = signal;
      try {
        try { await this.start(); } catch (error) { this.fail(error); throw error; }
        signal?.throwIfAborted();
        return await operation();
      } finally {
        signal?.removeEventListener('abort', abort);
        this.signal = undefined;
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }

  start() {
    this.starting ||= this.open();
    return this.starting;
  }

  async open() {
    const resolved = await this.launch();
    if (this.closed || this.failure) throw this.failure || new Error('Computer Use bridge is closed');
    await mkdir(resolved.state, { recursive: true, mode: 0o700 });
    this.root = await mkdtemp(join(resolved.state, 'run-'));
    const home = join(this.root, 'codex');
    const work = join(this.root, 'work');
    await mkdir(home, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    const config = `model="disabled"
model_provider="disabled"
web_search="disabled"
[model_providers.disabled]
name="Disabled"
base_url="http://127.0.0.1:9/v1"
wire_api="responses"
requires_openai_auth=false
request_max_retries=0
stream_max_retries=0
[features]
shell_tool=false
unified_exec=false
multi_agent=false
memories=false
plugins=false
remote_plugin=false
remote_control=false
hooks=false
[memories]
use_memories=false
generate_memories=false
[analytics]
enabled=false
[otel]
exporter="none"
[history]
persistence="none"
[mcp_servers.computer-use]
command=${JSON.stringify(resolved.client)}
args=["mcp"]
cwd=${JSON.stringify(work)}
startup_timeout_sec=30
tool_timeout_sec=120
`;
    await writeFile(join(home, 'config.toml'), config, { mode: 0o600 });
    if (this.closed || this.failure) throw this.failure || new Error('Computer Use bridge is closed');
    const env = { HOME: homedir(), CODEX_HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: this.root, NO_COLOR: '1' };
    for (const key of ['USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE']) if (process.env[key]) env[key] = process.env[key];
    this.process = spawn(resolved.codex, resolved.args || ['app-server', '--stdio'], { cwd: work, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.process.once('close', resolve));
    this.process.once('error', error => this.fail(error));
    this.process.once('close', () => { if (!this.closed) this.fail(new Error('Official app-server exited; actions are not retried.')); });
    this.process.stdin.on('error', error => { if (!this.closed) this.fail(error); });
    this.stderr = '';
    this.process.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-2000); });
    createInterface({ input: this.process.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch (error) { this.fail(error); }
    });
    await this.request('initialize', {
      clientInfo: { name: 'pi_computer_use', title: 'Pi Computer Use', version: '0.1.0' },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    });
    this.send({ method: 'initialized' });
    const started = await this.request('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: true, serviceName: 'pi_computer_use' });
    this.threadId = started.thread.id;
    const inventory = await this.request('mcpServerStatus/list', { threadId: this.threadId, serverName: 'computer-use' });
    const official = inventory.data.find(server => server.name === 'computer-use');
    if (!official || official.toolsError) throw new Error(official?.toolsError || 'Official Computer Use tool discovery failed');
    this.tools = METHODS.map(name => {
      if (!official.tools[name]) throw new Error(`Official Computer Use tool missing: ${name}`);
      return official.tools[name];
    });
  }

  send(message) {
    if (!this.process?.stdin.writable) throw new Error('Official app-server stdin is unavailable');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Official app-server timed out: ${method}. An action may already have executed; do not retry automatically.`)), 120000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { this.fail(error); }
    });
  }

  receive(message) {
    if (message.method?.startsWith('turn/') || message.method?.startsWith('item/')) {
      this.fail(new Error('Unexpected model-turn activity; Computer Use bridge stopped'));
      return;
    }
    if (message.method && message.id !== undefined) {
      if (message.method !== 'mcpServer/elicitation/request') {
        this.send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } });
        return;
      }
      void (async () => {
        let response = { action: 'cancel' };
        try { response = await this.onElicitation?.(message.params, this.signal) || response; }
        catch (error) { this.approvalError = error.message; }
        if (!this.closed && !this.failure) this.send({ id: message.id, result: response });
      })().catch(error => this.fail(error));
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }

  listTools(signal) {
    return this.run(() => ({ tools: this.tools }), signal);
  }

  call(name, args, signal) {
    if (!METHODS.includes(name)) return Promise.reject(new Error(`Unknown tool: ${name}`));
    return this.run(async () => {
      this.approvalError = undefined;
      const result = await this.request('mcpServer/tool/call', { threadId: this.threadId, server: 'computer-use', tool: name, arguments: args });
      if (this.approvalError) throw new Error(this.approvalError);
      return result;
    }, signal);
  }

  fail(error) {
    this.failure ||= error;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(this.failure); }
    this.pending.clear();
    void this.close().catch(error => console.error(error.message));
  }

  close() {
    this.closing ||= this.stop();
    return this.closing;
  }

  async stop() {
    this.closed = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Computer Use bridge closed')); }
    this.pending.clear();
    await this.starting?.catch(() => {});
    if (this.process?.pid) {
      const pid = this.process.pid;
      const kill = signal => {
        try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      this.process.stdin.end();
      const term = setTimeout(() => kill('SIGTERM'), 1000);
      const force = setTimeout(() => kill('SIGKILL'), 3000);
      await this.exited;
      clearTimeout(term); clearTimeout(force);
      kill('SIGTERM');
      const alive = () => {
        try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
      };
      for (let attempt = 0; attempt < 40 && alive(); attempt++) {
        if (attempt === 10) kill('SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (alive()) throw new Error('Computer Use process group did not terminate; runtime state retained');
    }
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}
