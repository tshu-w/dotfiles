---
name: intent-layer
description: "Authoring guide for building and maintaining an Intent Layer (AGENTS.md/CLAUDE.md intent nodes): progressive disclosure, LCA deduplication, leaf-first updates."
source: "https://www.intent-systems.com/learn/intent-layer"
---

## Purpose

Use this skill when you are **creating, editing, or reviewing** an *Intent Layer* in a repository.

An **Intent Layer** is a thin, hierarchical context system embedded in the repo. It is made of **Intent Nodes**: small, opinionated files (e.g., `AGENTS.md`, `CLAUDE.md`, or tool-specific equivalents) that explain what an area is for and how to work there safely.

Intent Nodes live at **semantic boundaries**: where responsibility shifts, contracts matter, or complexity warrants dedicated context.

## What the Intent Layer is for (two jobs)

1) **Compress context**: distill an area into the minimum high-signal tokens needed to operate safely.
2) **Surface hidden context**: invariants, boundaries, “why it’s this way,” cross-service contracts, landmines—things code alone won’t reliably communicate.

## Core design principles (non-negotiable)

- **Progressive disclosure**: start minimal/high-signal; drill into detail via hierarchy and downlinks.
- **Hierarchical loading**: when a node loads, its **ancestors** load too (T-shaped context: broad + local).
- **Semantic boundaries over folder-per-node**: use nodes where responsibility changes, not everywhere.
- **Least Common Ancestor (LCA) deduplication**: shared facts live once at the shallowest node that covers all relevant paths.
- **Don’t re-encode the code**: point to implementation via links; don’t duplicate what the code already states.
- **Keep nodes small but dense**: if it’s huge relative to the code, it’s adding weight instead of compression.

## What goes in an Intent Node (checklist)

Aim for “the briefing you’d hand a senior engineer” before they touch this area:

- **Purpose & scope**: what this area owns; what it explicitly does *not* do.
- **Entry points & contracts**: primary APIs/jobs/CLIs; key invariants (e.g., “only enforcement point for X”).
- **Usage patterns**: canonical ways to extend/modify this area.
- **Anti-patterns / landmines**: what to never do; sharp edges; common mistakes.
- **Dependencies & edges**: upstream/downstream coupling; cross-service contracts.
- **Patterns & pitfalls**: repeated confusions; hidden state; deploy-time overrides.
- **Downlinks / outlinks**: pointers to child nodes and other docs (ADRs, runbooks, diagrams).

### Suggested skeleton

```md
# <Area> — Intent Node

## Purpose

## Owns / Does not own

## Entry points & contracts

## How to change safely (canonical workflows)

## Pitfalls / anti-patterns

## Dependencies & edges

## Downlinks / outlinks
```

## Downlinks (keep context lean)

Some context lives outside the ancestor chain—use **downlinks** so it’s discoverable without loading everything up front.

- Downlink to **child intent nodes** (e.g., “If you’re changing validators, read `./validators/AGENTS.md`.”)
- Outlink to **other documentation** (ADRs, diagrams, runbooks) only when it adds signal

## File naming & auto-loading

Different agent harnesses auto-load different filenames. Treat naming as an **integration detail**:

- Choose the minimal approach that ensures nodes are auto-loaded across your tools/team.
- Avoid duplicating the same content across multiple filetypes—duplication bloats and drifts.

## Building the Intent Layer (capture workflow)

### 1) Chunking (optimize for compression)

- Aim for **~20k–64k tokens** per chunk of related code.
- Similar code summarizes better together; mixed concerns reduce clarity.
- Connect disparate areas via hierarchy (parent summaries), not via one mega file.

### 2) Leaf-first capture with SMEs (iterative)

Capture children before parents; easy areas before tangled ones.

Loop:
- Agent summarizes what it sees + asks clarifying questions.
- Human answers/corrects + adds history and landmines.
- Repeat until aligned and high-signal.

Keep shared state:
- Open questions to resolve later
- Cross-references to place later (find the LCA)
- Tasks that emerge (dead code candidates, refactors)

### 3) Hierarchical summarization (fractal compression)

When writing a parent node, summarize **child intent nodes**, not raw code.

### 4) Deduplicate shared knowledge (LCA rule)

If a fact applies to multiple areas, put it in the **Least Common Ancestor**:

- Not duplicated across leaves (will drift)
- Not shoved into the root (loads everywhere)
- The LCA loads exactly where it’s relevant

## Maintenance flywheel (keep it from rotting)

Treat intent nodes like code. On every merge/change:

1) Detect changed files
2) Identify which nodes cover those changes
3) Update **leaf-first**, then work upward
   - read diff + existing node
   - re-summarize if behavior changed
   - propose edits
4) Human reviews and merges like any code change

Agents will surface what’s missing—feed that back into nodes so future work starts with better context.

## Anti-patterns (avoid)

- One huge root file that overwhelms context instead of compressing
- Duplicating what code already says
- Writing for humans first (long narratives) instead of dense, actionable guidance
- Duplicating the same content across filetypes/tooling
- Letting nodes drift out of sync because no one owns updates
