import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const APP = "π";

const active = Boolean(process.stdout.isTTY);
const isITerm = active && process.env.TERM_PROGRAM === "iTerm.app";

// One-time cleanup: earlier versions colored the tab; reset any leftover color.
if (isITerm) {
	process.stdout.write("\x1b]6;1;bg;*;default\x07");
}

function setTitle(title: string): void {
	if (!active) return;
	process.stdout.write(`\x1b]0;${title}\x07`);
}

export default function (pi: ExtensionAPI) {
	const render = () => {
		const name = pi.getSessionName();
		setTitle(name ? `${APP} - ${name}` : APP);
	};

	pi.on("session_start", render);
	pi.on("agent_start", render);
	pi.on("session_info_changed", render);
}
