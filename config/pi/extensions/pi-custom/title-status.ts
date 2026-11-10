import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const APP = "π";

export default function (pi: ExtensionAPI) {
  const render = (_event: unknown, ctx: ExtensionContext) => {
    const name = pi.getSessionName();
    ctx.ui.setTitle(name ? `${APP} - ${name}` : APP);
  };

  pi.on("session_start", render);
  pi.on("agent_start", render);
  pi.on("session_info_changed", render);
}
