import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// After Pi exhausts its own retries, continue the same run with the next scoped model.
export default function (pi: ExtensionAPI) {
	let initial: Parameters<ExtensionAPI["setModel"]>[0] | undefined;
	const tried = new Set<string>();
	const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "error" || !ctx.model) return;
		const failed = event.context.contextEntries.at(-1);
		if (failed?.messages.at(-1)?.role !== "assistant") return;
		initial ??= ctx.model;
		tried.add(key(ctx.model));
		for (const { model } of ctx.scopedModels) {
			if (tried.has(key(model))) continue;
			tried.add(key(model));
			if (!(await pi.setModel(model))) continue;
			// Omit the failed reply, as Pi's own retry does, so the run resumes without repeating work.
			return { entries: [{ type: "context_edit", targetId: failed.sourceEntry.id, replacement: null }], continue: true };
		}
	});

	pi.on("agent_settled", async () => {
		if (initial) await pi.setModel(initial);
		initial = undefined;
		tried.clear();
	});
}
