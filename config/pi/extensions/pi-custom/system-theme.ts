import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 2000;

async function isDarkMode(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults", ["read", "-g", "AppleInterfaceStyle"]);
    return stdout.trim() === "Dark";
  } catch {
    return false;
  }
}

export function registerSystemTheme(pi: ExtensionAPI): void {
  let intervalId: ReturnType<typeof setInterval> | undefined;
  let checking = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    let currentTheme: "dark" | "light" | undefined;
    const syncTheme = async () => {
      if (checking) return;
      checking = true;
      try {
        const newTheme = (await isDarkMode()) ? "dark" : "light";
        if (newTheme !== currentTheme) {
          currentTheme = newTheme;
          ctx.ui.setTheme(currentTheme);
        }
      } finally {
        checking = false;
      }
    };

    await syncTheme();
    intervalId = setInterval(() => void syncTheme(), POLL_INTERVAL_MS);
  });

  pi.on("session_shutdown", () => {
    if (intervalId) clearInterval(intervalId);
    intervalId = undefined;
  });
}
