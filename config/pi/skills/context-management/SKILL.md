---
name: context-management
description: Agentic context management using pi-control (anchor/pivot/view/recall + cross-model calls). Covers detecting work phase shifts, proactive checkpointing, pivots, cross-session recall, handoff, and using a different model for review/consult/handoff. Use when working on long tasks, switching approaches, when context is high, when past work might be relevant, or when a non-trivial change benefits from a different model's perspective.
---

# Context Management

Manage your own context window proactively. Read the conversation for signals of phase shifts, risk points, and topic recurrence. Never wait for the user to tell you.

## Mental Model

Your session is an **append-only tape** forming a tree. **Anchors** mark past state at meaningful boundaries (retrospective only, not todos). Changing direction is a **handoff** — `pivot` within a session, `resume + message` across sessions. Tool results older than the last anchor are auto-truncated; anchors stay visible.

## Core Loop

```
(signals → recall) → work
  → (signals → boundary) → anchor
    → work → pivot / compact / cross-session handoff as signals demand
```

## Recall Before Starting

Signals: user mentions a topic you might have worked on, task resembles prior work, user says "continue from where we were".

1. `context(recall, keyword=<topic>)` — default scope is `cwd`; pass `scope="all"` for cross-project.
2. If a relevant session is found → `sessions(resume, sessionFile=..., message="Handoff: <directive>")`.
3. Otherwise proceed fresh; if starting a related-but-new line, `sessions(new, linkParent=true, message="Start with: <task>")`.

The `message` is injected as a user message into the target session, driving its first turn.

## Anchor

Signals: subtask complete, about to do something risky, user confirmed a decision, phase shifting (plan→implement), heavy tool-use coming, non-trivial state since last anchor.

- `name`: short phase/intent (`"plan-done"`, `"auth-impl"`, `"review-round-2"`)
- `summary`: what's done/known/decided — **retrospective, not todo**

Bad: `anchor(name="add-tests", summary="will add tests next")` — that's a todo.
Good: `anchor(name="auth-impl-done", summary="auth flow implemented; tests next")`.

On name collision, error shows existing summary — pick a better name (e.g. `-v2`).

## Pivot (within-session)

Signals: same approach failed 2+ times, premise turned out wrong, topic shift, context full and want an earlier clean branch.

`context(pivot, target=<anchor>, carryover=<what to preserve>, message?=<directive>)`

Carryover = what survives the jump (attempts, learnings, decisions).
Pass `message` to drive the next turn after the pivot lands; otherwise the new branch starts idle and waits for input.

## View

`context(view)` before pivot, after resume, or to understand anchor topology.

## Compact

Signals: `pi-status` shows `context=70%+` OR `tool=40%+` (tool output dominates the surface), OR a single tool result just caused a large context jump, direction unchanged but state accumulated, heavy tool-use incoming.

`tree(compact)` shrinks the current path. Compact keeps direction; pivot changes direction.

Pass `message` to drive the next turn after compaction (e.g. `tree(compact, message="Resume the test fix.")`); otherwise the session waits for input.

## Pattern: Cross-Model Calls

Different models have different priors and failure modes. Use a different model when you want a perspective the current one wouldn't easily produce: review (audit a change), consult (ask before deciding), handoff (plan with one, implement with another), digest (cheap model for summarizing).

Use latest Claude Opus as implementor; for review pick Gemini Pro (pattern issues) or GPT (logic-chain). For critical review run both in sequence. Always start from scoped models (`models(list, scope="scoped")`); only use `scope="all"` if the user asked.

**Review loop** (most common — iterate until reviewer approves):

```
1. (Claude) work → context(anchor, name="<subject>-impl-N", ...)
2. models(switch, modelId="<reviewer>", thinkingLevel="high",
          message="Review anchor <subject>-impl-N. Give concrete issues.")
3. (reviewer) feedback
4. models(switch, modelId="<claude-opus>", message="Apply the feedback above.")
5. (Claude) fixes → context(anchor, name="<subject>-fix-N", ...)
end on the implementor; loop until reviewer approves or you stop.
```

For narrow one-shot opinions (consult, single question), use `models(consult, ...)` instead of switching — no full session handoff.

## Rules

1. **Recall before starting.** Don't redo past work.
2. **Anchor at semantic boundaries.** Read signals, not step count.
3. **Anchors are retrospective.** Summary only; never encode future tasks.
4. **Never pivot without carryover.** Carryover is your memory across the jump.
5. **Compact keeps direction. Pivot changes direction.**
6. **View before pivot.** Confirm target from the anchor list first.
7. **Prefer scoped models.** Only use `scope="all"` when the user asked.
8. **End cross-model loops on the implementor.** Don't leave session on a reviewer.
