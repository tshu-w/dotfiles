export interface AnchorState {
	name: string;
	targetId: string;
	summary: string;
}

export function isAnchorToolResult(m: any): boolean {
	return m?.role === "toolResult" && m?.toolName === "context" && !!m?.details?.anchor;
}

export function isAnchorEntry(e: any): boolean {
	return e?.type === "message" && isAnchorToolResult(e?.message);
}

export function resolveTarget(sm: any, target: string): string | null {
	if (target === "head") return sm.getLeafId() ?? null;
	if (target === "root") {
		const tree = sm.getTree();
		return tree.length > 0 ? tree[0].entry.id : null;
	}
	if (/^[0-9a-f]{8,}$/i.test(target)) {
		if (sm.getEntry(target)) return target;
		// Fall through: target might look hex-like but actually be an anchor/label name.
	}
	// Prefer anchor name over generic label
	const anchor = findAnchorByName(sm, target);
	if (anchor) return anchor.targetId;
	// Fall back to label lookup
	const entries = sm.getEntries();
	for (const e of entries) {
		if (sm.getLabel(e.id) === target) return e.id;
	}
	return null;
}

export function getAnchors(sm: any): Array<{ id: string; data: AnchorState }> {
	return sm.getEntries()
		.filter(isAnchorEntry)
		.map((e: any) => {
			const raw = e.message.details.anchor;
			return {
				id: e.id,
				data: {
					name: raw.name,
					targetId: raw.targetId,
					summary: raw.summary,
				} as AnchorState,
			};
		});
}

export function findAnchorByName(sm: any, name: string): AnchorState | null {
	const anchors = getAnchors(sm);
	for (const a of anchors) {
		if (a.data?.name === name) return a.data;
	}
	return null;
}

export function formatAnchorContent(name: string, summary: string): string {
	return `[Anchor: ${name}]\n${summary}`;
}
