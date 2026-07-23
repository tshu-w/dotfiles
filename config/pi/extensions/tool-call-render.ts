import { Text } from "@earendil-works/pi-tui";

type ToolCallTheme = {
	bold(text: string): string;
	fg(color: "toolTitle" | "muted" | "text", text: string): string;
};

function renderValue(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

export function renderToolCall(name: string, args: unknown, theme: ToolCallTheme): Text {
	const entries = Object.entries((args ?? {}) as Record<string, unknown>)
		.filter(([, value]) => value !== undefined);
	let text = theme.fg("toolTitle", theme.bold(name)) + theme.fg("muted", "(");
	for (let index = 0; index < entries.length; index += 1) {
		const [key, value] = entries[index]!;
		if (index > 0) text += theme.fg("muted", ", ");
		text += theme.fg("muted", `${key}=`) + theme.fg("text", renderValue(value));
	}
	return new Text(text + theme.fg("muted", ")"), 0, 0);
}
