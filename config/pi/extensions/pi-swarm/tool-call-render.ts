import { Text } from "@earendil-works/pi-tui";

type ToolCallTheme = {
	bold(text: string): string;
	fg(color: "toolTitle" | "text", text: string): string;
};

function renderValue(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

export function renderToolCall(name: string, args: unknown, theme: ToolCallTheme, resultReady = false): Text {
	const entries = Object.entries((args ?? {}) as Record<string, unknown>)
		.filter(([, value]) => value !== undefined);
	let text = theme.fg("toolTitle", theme.bold(name)) + theme.fg("text", "(");
	for (let index = 0; index < entries.length; index += 1) {
		const [key, value] = entries[index]!;
		if (index > 0) text += theme.fg("text", ", ");
		text += theme.fg("text", `${key}=${renderValue(value)}`);
	}
	return new Text(text + theme.fg("text", ")") + (resultReady ? "\n" : ""), 0, 0);
}
