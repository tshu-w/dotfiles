import { homedir } from 'node:os';
import { join } from 'node:path';

export function paths(env = process.env, home = homedir()) {
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  return {
    pi: env.PI_CODING_AGENT_DIR || join(config, 'pi'),
    state: join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'pi', 'chatgpt-computer-use'),
    codex: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    client: join(config, 'codex', 'computer-use', 'Codex Computer Use.app', 'Contents', 'SharedSupport', 'SkyComputerUseClient.app', 'Contents', 'MacOS', 'SkyComputerUseClient'),
  };
}
