/**
 * Branch-grouped session overview for tree(scope="all").
 *
 * Shows the session as a shallow tree:
 *   - current branch as spine
 *   - side branches grouped under their fork points
 *
 * No anchor awareness — tree is the structural layer.
 * Labels on entries are shown if present.
 */

// ── Types ───────────────────────────────────────────

export interface TreeNode {
	entry: { id: string; [key: string]: any };
	children: TreeNode[];
	label?: string;
}

export interface EntrySummary {
	id: string;
	shortId: string;
	timestamp: string;
	kind: string;
	preview: string;
	label?: string;
}

export interface SideBranchSummary {
	rootEntry: EntrySummary;
	tipEntry: EntrySummary;
	lastActive: string;
	pathLength: number;
	descendantLeafCount: number;
	nestedBranchCount: number;
}

export interface ForkPointGroup {
	forkEntry: EntrySummary;
	branches: SideBranchSummary[];
}

export interface CurrentBranchSummary {
	tipEntry: EntrySummary;
	branchLength: number;
	lastActive: string;
	totalSideBranches: number;
	totalForkPoints: number;
}

export interface GroupedOverview {
	currentBranch: CurrentBranchSummary;
	totalForkPoints: number;
	totalSideBranches: number;
	offset: number;
	limit: number;
	shownForkPoints: number;
	hasMore: boolean;
	forkPoints: ForkPointGroup[];
}

// ── Helpers ─────────────────────────────────────────

function inline(text: string, max = 80): string {
	return text.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function summarizeContent(content: any): string {
	if (typeof content === "string") return inline(content);
	if (!Array.isArray(content)) return "";

	const textParts: string[] = [];
	for (const part of content) {
		if (part?.type === "text" && typeof part.text === "string") {
			textParts.push(part.text);
		}
		if (part?.type === "toolCall" && typeof part.name === "string") {
			return `[tool: ${part.name}]`;
		}
	}
	return inline(textParts.join(" "));
}

function getEntryKind(entry: any): string {
	switch (entry.type) {
		case "message":
			return entry.message?.role ?? "message";
		case "custom_message":
			return entry.customType ?? "custom_message";
		default:
			return entry.type ?? "entry";
	}
}

function getEntryPreview(entry: any): string {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			if (!msg) return "";
			if (msg.role === "toolResult") {
				return `[${msg.toolName ?? "tool"}] ${msg.isError ? "ERROR" : "OK"}`;
			}
			return summarizeContent(msg.content);
		}
		case "branch_summary":
		case "compaction":
			return inline(entry.summary ?? "");
		case "custom_message":
			return typeof entry.content === "string"
				? inline(entry.content)
				: summarizeContent(entry.content);
		case "model_change":
			return `${entry.provider ?? "?"}/${entry.modelId ?? "?"}`;
		case "thinking_level_change":
			return entry.thinkingLevel ?? "";
		case "label":
			return entry.label ?? "";
		case "session_info":
			return entry.name ?? "";
		default:
			return "";
	}
}

function summarizeEntry(entry: any, label?: string): EntrySummary {
	const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
	const result: EntrySummary = {
		id: entry.id,
		shortId: String(entry.id ?? "?").slice(0, 8),
		timestamp,
		kind: getEntryKind(entry),
		preview: getEntryPreview(entry),
	};
	if (label) result.label = label;
	return result;
}

function getTimestampValue(entry: any): number {
	if (!entry?.timestamp) return 0;
	const value = Date.parse(entry.timestamp);
	return Number.isFinite(value) ? value : 0;
}

function indexTree(roots: TreeNode[]): Map<string, TreeNode> {
	const byId = new Map<string, TreeNode>();
	const stack: TreeNode[] = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		byId.set(node.entry.id, node);
		for (const child of node.children) stack.push(child);
	}
	return byId;
}

// ── Core ────────────────────────────────────────────

function summarizeSideBranch(familyRoot: TreeNode): SideBranchSummary {
	let descendantLeafCount = 0;
	let latestLeaf: TreeNode | null = null;
	let latestLeafTime = -1;
	let latestPathLen = 0;
	let latestRepresentative: TreeNode = familyRoot;

	// Iterative DFS. Each frame carries the nearest ancestor with a non-empty
	// preview so the representative entry can be computed without path arrays.
	type Frame = { node: TreeNode; ancestorWithPreview: TreeNode | null; depth: number };
	const stack: Frame[] = [{ node: familyRoot, ancestorWithPreview: null, depth: 1 }];
	while (stack.length > 0) {
		const { node, ancestorWithPreview, depth } = stack.pop()!;
		const hasPreview = getEntryPreview(node.entry).length > 0;
		const nextAncestor = hasPreview ? node : ancestorWithPreview;

		if (node.children.length === 0) {
			descendantLeafCount += 1;
			const ts = getTimestampValue(node.entry);
			if (!latestLeaf || ts > latestLeafTime) {
				latestLeaf = node;
				latestLeafTime = ts;
				latestPathLen = depth;
				latestRepresentative = hasPreview ? node : (ancestorWithPreview ?? node);
			}
			continue;
		}

		for (const child of node.children) {
			stack.push({ node: child, ancestorWithPreview: nextAncestor, depth: depth + 1 });
		}
	}

	const tipNode = latestLeaf ?? familyRoot;
	return {
		rootEntry: summarizeEntry(familyRoot.entry, familyRoot.label),
		tipEntry: summarizeEntry(latestRepresentative.entry, latestRepresentative.label),
		lastActive: String(tipNode.entry.timestamp ?? ""),
		pathLength: latestPathLen || 1,
		descendantLeafCount,
		nestedBranchCount: Math.max(0, descendantLeafCount - 1),
	};
}

export function buildGroupedOverview(
	roots: TreeNode[],
	currentBranchEntries: any[],
	getLabel: ((id: string) => string | undefined) | undefined,
	offset = 0,
	limit = 20,
): GroupedOverview | null {
	if (currentBranchEntries.length === 0) return null;

	const currentBranchIds = new Set(currentBranchEntries.map((e: any) => e.id));
	const byId = indexTree(roots);

	// Collect fork points (current branch entries that have off-branch children)
	const forkPoints: ForkPointGroup[] = [];
	let totalSideBranches = 0;

	for (const entry of currentBranchEntries) {
		const node = byId.get(entry.id);
		if (!node) continue;

		const offBranchChildren = node.children.filter(c => !currentBranchIds.has(c.entry.id));
		if (offBranchChildren.length === 0) continue;

		const branches = offBranchChildren.map(child => summarizeSideBranch(child));
		// Sort branches within fork point: newest first, then by tip id for stability
		branches.sort((a, b) => {
			const ta = Date.parse(a.lastActive || "") || 0;
			const tb = Date.parse(b.lastActive || "") || 0;
			if (tb !== ta) return tb - ta;
			return a.tipEntry.id.localeCompare(b.tipEntry.id);
		});

		const label = getLabel?.(entry.id);
		forkPoints.push({
			forkEntry: summarizeEntry(entry, label),
			branches,
		});
		totalSideBranches += branches.length;
	}

	// Fork points are in branch order (root→tip). Reverse so newest fork point first.
	forkPoints.reverse();

	const page = forkPoints.slice(offset, offset + limit);
	const tipEntry = currentBranchEntries[currentBranchEntries.length - 1];
	const tipLabel = getLabel?.(tipEntry.id);

	return {
		currentBranch: {
			tipEntry: summarizeEntry(tipEntry, tipLabel),
			branchLength: currentBranchEntries.length,
			lastActive: String(tipEntry.timestamp ?? ""),
			totalSideBranches,
			totalForkPoints: forkPoints.length,
		},
		totalForkPoints: forkPoints.length,
		totalSideBranches,
		offset,
		limit,
		shownForkPoints: page.length,
		hasMore: offset + page.length < forkPoints.length,
		forkPoints: page,
	};
}

// ── Render ──────────────────────────────────────────

function fmtEntry(entry: EntrySummary): string {
	const ts = entry.timestamp ? entry.timestamp.slice(0, 19) : "";
	const label = entry.label ? ` (${entry.label})` : "";
	const preview = entry.preview ? `: ${entry.preview}` : "";
	return `[${entry.shortId}] ${ts} ${entry.kind}${label}${preview}`;
}

export function renderGroupedOverview(overview: GroupedOverview): string[] {
	const lines: string[] = [];
	const current = overview.currentBranch;
	const fps = overview.forkPoints;

	lines.push(`current branch (${current.branchLength} entries, tip ${fmtEntry(current.tipEntry)})`);

	if (fps.length === 0) {
		if (overview.totalForkPoints === 0) {
			lines.push("(no side branches)");
		} else {
			lines.push(`(no fork points on this page, offset ${overview.offset})`);
		}
		return lines;
	}

	for (let fi = 0; fi < fps.length; fi++) {
		const fp = fps[fi];
		const isLastFp = fi === fps.length - 1 && !overview.hasMore;
		const fpPrefix = isLastFp ? "└─ " : "├─ ";
		const fpCont = isLastFp ? "   " : "│  ";

		lines.push(`${fpPrefix}${fmtEntry(fp.forkEntry)}`);
		for (let bi = 0; bi < fp.branches.length; bi++) {
			const branch = fp.branches[bi];
			const isLastBr = bi === fp.branches.length - 1;
			const brPrefix = isLastBr ? "└─ " : "├─ ";
			const nested = branch.nestedBranchCount > 0 ? `, ${branch.descendantLeafCount} leaves, ${branch.nestedBranchCount} nested` : "";
			const stats = `${branch.pathLength} entries${nested}`;
			lines.push(`${fpCont}${brPrefix}${fmtEntry(branch.tipEntry)} (${stats})`);
		}
	}

	if (overview.hasMore) {
		lines.push(`... ${overview.totalForkPoints - overview.offset - overview.shownForkPoints} more fork points, use offset ${overview.offset + overview.shownForkPoints}`);
	}

	return lines;
}
