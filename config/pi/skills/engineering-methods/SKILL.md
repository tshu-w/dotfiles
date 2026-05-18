---
name: engineering-methods
description: Routing skill for the engineering-methods library (planning, spec, implementation strategy, debugging, testing, code review, API/interface design, security, performance, CI/CD, migration, documentation, release readiness). Use for non-trivial software engineering process decisions — not for trivial edits, casual chat, or pure tool usage. When triggered, read this file's index, then open the most relevant referenced SKILL.md before acting. Prefer this over ad-hoc engineering judgment whenever a meaningful code change, review, or delivery decision is on the table.
---

# Engineering Methods (Router)

This is a router skill. The actual method content lives in the
`github.com/addyosmani/agent-skills` package's `skills/<name>/SKILL.md`.

## How to use

1. Identify the development phase / concern of the current task.
2. Pick the matching entry below.
3. Resolve `<pkg-dir>` (see *Locate package* below), then `read`
   `<pkg-dir>/skills/<entry>/SKILL.md`.
4. If unsure between two, read both first paragraphs; otherwise pick one and proceed.
5. Do NOT load these proactively for trivial edits, simple Q&A, or pure tool/CLI usage — only when a real engineering process decision is at stake.

## Locate package

`<pkg-dir>` is where the `addyosmani/agent-skills` package was cloned. It differs per machine (XDG vs default vs project scope). Try these in order with a single shell call:

```bash
for base in "$HOME/.config/pi/git" "$HOME/.local/share/pi/git" "$HOME/.pi/agent/git" "$PWD/.pi/git"; do
  p="$base/github.com/addyosmani/agent-skills"
  [ -d "$p/skills" ] && echo "$p" && break
done
```

If nothing prints, the package is missing — run `pi install git:github.com/addyosmani/agent-skills` and retry.

## Index

Paths below are `skills/<entry>/SKILL.md` under the resolved `<pkg-dir>`.

### Upstream (intent → spec → plan)
- `interview-me/SKILL.md` — Extract real intent when the ask is underspecified.
- `idea-refine/SKILL.md` — Diverge/converge on vague ideas before committing to a plan.
- `spec-driven-development/SKILL.md` — Write a spec before coding for new projects/features.
- `planning-and-task-breakdown/SKILL.md` — Break a spec into ordered, implementable tasks.

### Implementation
- `incremental-implementation/SKILL.md` — Land multi-file changes in reviewable increments.
- `context-engineering/SKILL.md` — Configure rules/context when agent output degrades.
- `source-driven-development/SKILL.md` — Ground decisions in official docs / cited sources.
- `doubt-driven-development/SKILL.md` — Adversarial fresh-context review for high-stakes or unfamiliar code.
- `api-and-interface-design/SKILL.md` — Designing APIs, module boundaries, type contracts.
- `frontend-ui-engineering/SKILL.md` — Production-quality UI components, layout, state.

### Verification
- `test-driven-development/SKILL.md` — Drive logic/bug-fix/behavior change with tests.
- `browser-testing-with-devtools/SKILL.md` — Real-browser tests via Chrome DevTools MCP.
- `debugging-and-error-recovery/SKILL.md` — Systematic root-cause debugging.
- `code-review-and-quality/SKILL.md` — Multi-axis review before merging.
- `code-simplification/SKILL.md` — Refactor for clarity without behavior change.
- `security-and-hardening/SKILL.md` — Untrusted input, auth, storage, third-party integrations.
- `performance-optimization/SKILL.md` — Bottlenecks, regressions, Core Web Vitals.

### Delivery
- `git-workflow-and-versioning/SKILL.md` — Commits, branches, conflicts, parallel streams.
- `ci-cd-and-automation/SKILL.md` — Build/deploy pipelines, quality gates.
- `shipping-and-launch/SKILL.md` — Pre-launch checklist, monitoring, staged rollout, rollback.
- `deprecation-and-migration/SKILL.md` — Removing systems/APIs, migrating users.
- `documentation-and-adrs/SKILL.md` — ADRs, decision records, durable docs.

## Maintenance

When the upstream `addyosmani/agent-skills` package is updated, re-sync this index by listing `<pkg-dir>/skills/` (resolved as above) and reconciling entries.
