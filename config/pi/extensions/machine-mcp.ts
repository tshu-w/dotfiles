import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { paths as computerUsePaths } from "../mcp/chatgpt-computer-use/paths.mjs";

export default function machineMcp(pi: ExtensionAPI) {
  if (existsSync(computerUsePaths().client)) pi.registerMcpServer("computer-use", {
    command: "/bin/sh",
    args: ["-c", 'exec node "${PI_CODING_AGENT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/pi}/mcp/chatgpt-computer-use/server.mjs"'],
    timeout: 130,
    exposure: "codemode",
    description: "Control macOS apps through official ChatGPT Computer Use",
  });
  if (existsSync("/opt/homebrew/bin/pinkyctl")) pi.registerMcpServer("pinky", {
    command: "/opt/homebrew/bin/pinkyctl",
    args: ["mcp"],
    exposure: "codemode",
    description: "Operate phones through Pinky with human approvals",
  });
}
