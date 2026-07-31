import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const APP = "π";

export default function (pi: ExtensionAPI) {
	let resetITermTabColor = false;

	const render = (_event: unknown, ctx: ExtensionContext) => {
		if (
			!resetITermTabColor
			&& ctx.mode === "tui"
			&& process.stdout.isTTY
			&& process.env.TERM_PROGRAM === "iTerm.app"
		) {
			// One-time cleanup: earlier versions colored the tab.
			process.stdout.write("\x1b]6;1;bg;*;default\x07");
			resetITermTabColor = true;
		}

		const name = pi.getSessionName();
		ctx.ui.setTitle(name ? `${APP} - ${name}` : APP);
	};

	pi.on("session_start", render);
	pi.on("agent_start", render);
	pi.on("session_info_changed", render);
}
