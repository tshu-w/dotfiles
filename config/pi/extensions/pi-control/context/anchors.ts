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

/**
 * Detect an `assistant` message entry that contains the anchor toolCall.
 * Used to confirm an anchor's recorded targetId really points to its own
 * toolCall before walking to the toolResult child.
 */
function isAnchorToolCallEntry(e: any, anchorName?: string): boolean {
	if (e?.type !== "message" || e?.message?.role !== "assistant") return false;
	const content = e.message?.content;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (block?.type !== "toolCall" || block?.name !== "context") continue;
		const args = block?.arguments;
		if (args?.action !== "anchor") continue;
		if (anchorName && args?.name !== anchorName) continue;
		return true;
	}
	return false;
}

/**
 * Resolve an anchor's targetId to the entry carrying its rendered summary.
 *
 * Anchors record targetId from `getLeafId()` at toolCall execute() time, which
 * is the assistant message containing the toolCall — the toolResult child
 * (which holds the user-visible summary) does not yet exist. Pivoting to the
 * toolCall id alone leaves the toolResult as a sibling outside the new branch,
 * so we walk to the matching toolResult child whenever possible.
 *
 * Protocol assumption: a toolResult message is the direct child of the
 * assistant message containing its toolCall. If that changes, the parentId
 * filter degrades to returning the original id rather than raising.
 */
function resolveAnchorTarget(sm: any, anchor: AnchorState): string {
	const id = anchor.targetId;
	if (!id) return id;
	const entry = sm.getEntry(id);
	if (!entry) return id;

	// Already on an anchor toolResult: nothing to resolve.
	if (isAnchorEntry(entry)) return id;

	// Only resolve when targetId really points to the matching anchor toolCall.
	if (!isAnchorToolCallEntry(entry, anchor.name)) return id;

	const entries = sm.getEntries();
	const children = entries.filter((e: any) => e?.parentId === id);

	// Pick the anchor toolResult child whose details point back to this toolCall
	// (or are unset, for legacy data) and match by name. Weaker fallbacks would
	// only fire on corrupted data, where guessing risks the wrong target.
	for (const child of children) {
		if (!isAnchorEntry(child)) continue;
		const a = child.message?.details?.anchor;
		const nameOk = !a?.name || a.name === anchor.name;
		const targetOk = !a?.targetId || a.targetId === id;
		if (nameOk && targetOk) return child.id;
	}

	return id;
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
	if (anchor) return resolveAnchorTarget(sm, anchor);
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
