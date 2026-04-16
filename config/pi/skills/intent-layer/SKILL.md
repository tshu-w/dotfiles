---
name: intent-layer
description: Build, audit, and maintain an Intent Layer (AGENTS.md / CLAUDE.md intent nodes) for large codebases. Use this whenever the user asks to create/edit/review AGENTS.md or CLAUDE.md files, define repo context hierarchy, capture architectural invariants for agents, or improve agent reliability via progressive disclosure and LCA deduplication. Also use for onboarding repos to agent workflows, resolving duplicated node content, or designing leaf-first maintenance updates after code changes.
---

# Intent Layer

Use this skill to build or maintain a **token-efficient context system** for agents.

An Intent Layer is a sparse hierarchy of **Intent Nodes** (`AGENTS.md`, `CLAUDE.md`, or tool-equivalent files) placed at semantic boundaries.

This is not generic docs writing. The goal is to improve agent task quality on real code changes.

## What “good” looks like

Every update should improve these two outcomes:

1. **Compress context**: represent large code areas with minimal high-signal tokens.
2. **Surface hidden context**: capture invariants, boundaries, pitfalls, and rationale that code alone does not communicate.

## Core operating model

- **Progressive disclosure**: start with concise high-signal context; drill deeper only when needed.
- **Hierarchical loading**: when a node is active, its ancestor chain should provide the big picture (T-shaped context).
- **Semantic boundaries over folder-per-node**: place nodes where responsibilities shift.
- **Leaf-first capture**: write/update child nodes before parent nodes.
- **Hierarchical summarization**: parent nodes summarize child intent nodes, not raw code dumps.
- **LCA deduplication**: shared facts belong in the Least Common Ancestor node.
- **Downlinks for discoverability**: link to child nodes and high-value external docs (ADRs/runbooks) without loading everything upfront.
- **Tool-aware filenames**: pick naming/bridging that matches the harnesses in use (Claude Code, Codex, Cursor, pi, etc.) with minimal duplication.

## Execution protocol

Follow this sequence unless the user asks for a narrower scope.

### 1) Capture request mode

Classify the task first:

- **Bootstrap**: create an Intent Layer for a repo/area
- **Update**: edit existing nodes after code/context changes
- **Audit**: evaluate quality and identify gaps/drift
- **Migration**: align file naming/loading across tools
- **Maintenance design**: define ongoing sync workflow

If key inputs are missing, ask only what is necessary:

- Which harnesses/tools must auto-load these nodes?
- Which repo paths are in scope?
- Is this a one-time update or a repeatable maintenance loop?

### 2) Recon the codebase and current nodes

Before writing:

- Inspect existing intent files and architecture boundaries.
- Identify ownership boundaries, contracts, invariants, pitfalls, and cross-area coupling.
- Track unresolved items in a short shared-state list (`open questions`, `cross-references`, `follow-up tasks`).

### 3) Plan node placement (sparse tree)

Propose a compact node map:

- Put nodes only at semantic boundaries.
- Keep each node small/dense.
- For mixed concerns, split into separate child nodes and connect via hierarchy/downlinks.

Compression hint: related 20k–64k token code regions often summarize best.

### 4) Author or revise nodes leaf-first

For each leaf node, include actionable guidance:

- Purpose and explicit non-goals
- Entry points and contracts/invariants
- Safe change patterns
- Pitfalls / anti-patterns
- Dependencies and edges
- Downlinks to deeper context

Prefer concise, operational phrasing over narrative prose.

### 5) Summarize upward

After leaves are stable:

- Update parent nodes to summarize child intent.
- Keep parent nodes as coordination context, not implementation detail dumps.

### 6) Run LCA dedup pass

For each shared fact, ask:

> What is the shallowest node where this fact is always relevant?

Move it there. Remove duplicate copies from leaves and root.

### 7) Maintenance loop definition (if requested or absent)

Define a sync process tied to merges:

1. Detect changed files
2. Map changed files to covering nodes
3. Update nodes leaf-first, then parents
4. Human-review updates like normal code changes

If useful, include a lightweight reinforcement step: capture agent confusion/missed edge cases and feed them back into nodes.

## Node template (recommended)

```md
# <Area> — Intent Node

## Purpose
## Owns / Does not own
## Entry points & contracts
## How to change safely
## Pitfalls / anti-patterns
## Dependencies & edges
## Downlinks
```

## Quality checklist

A node set is healthy when:

- Nodes are concise and high-signal (not bloated prose)
- Shared facts appear once at LCA, not duplicated everywhere
- Parent/child hierarchy matches architecture boundaries
- Downlinks help discovery without forcing full upfront load
- Content explains "why" and constraints, not just "what code exists"
- Updates are tied to code-change workflow to prevent drift

## Common failure modes

- One giant root file that harms context quality
- Rephrasing source code instead of adding hidden operational context
- Duplicating identical content across `AGENTS.md`/`CLAUDE.md` without a compatibility strategy
- Writing for human long-form reading instead of token-limited agent execution
- Letting nodes drift because ownership/update flow is undefined

## References

- [Intent Layer — intent-systems.com](https://www.intent-systems.com/learn/intent-layer)
