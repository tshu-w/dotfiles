import { fileURLToPath } from "node:url";

// Loads the workspace's settings into Pi's environment once, whichever process started Pi, so commands
// such as the telegram skill's can use them. Variables already set keep their values.
export default function () {
	process.loadEnvFile(fileURLToPath(new URL("../../pi-assistant.env", import.meta.url)));
}
