---
name: engineering-methods
description: "Routing skill for engineering workflow methods (two upstream packs: addyosmani/agent-skills and mattpocock/skills). Covers intent grilling, specs/PRDs, task breakdown, implementation strategy, TDD, debugging, code review, API/interface design, codebase architecture, domain modeling, security, performance, CI/CD, migration, documentation, release readiness. Use for non-trivial software engineering process decisions — not for trivial edits, casual chat, or pure tool usage. When triggered, read this file's index, then open the most relevant referenced SKILL.md before acting."
---

# Engineering Methods (Router)

Methods come from two upstream packages:

- `github.com/addyosmani/agent-skills` — broad lifecycle guardrails (spec → plan → build → verify → review → ship).
- `github.com/mattpocock/skills` — opinionated idea→ship flow: grilling, domain language, deep modules, issue-driven implementation.

## How to use

1. Only when an engineering process decision is needed, select a relevant method using *Route selection* and the index.
2. Resolve the package directory and read its `SKILL.md`; if unsure between two candidates, compare their first paragraphs.

## Locate packages

Package dirs differ per machine (XDG vs default vs project scope). Resolve both with a single shell call:

```bash
for repo in "addyosmani/agent-skills" "mattpocock/skills"; do
  for base in "$HOME/.config/pi/git" "$HOME/.local/share/pi/git" "$HOME/.pi/agent/git" "$PWD/.pi/git"; do
    p="$base/github.com/$repo"
    [ -d "$p/skills" ] && echo "$repo => $p" && break
  done
done
```

If a repo doesn't print, install it: `pi install git:github.com/<owner>/<repo>`.

## Route selection

- **Matt (`mattpocock/skills`):** Requirements clarification, domain modeling, codebase architecture, issue-driven development, cross-session planning, and debugging.
- **Addy (`addyosmani/agent-skills`):** General development workflows, security, performance, CI/CD, migration, release, frontend, observability, source-cited research, and adversarial self-review.
- **Overlapping methods:** Choose Matt for concise, seam- and spec-focused guidance; Addy for comprehensive checklists.

## Matt index — `mattpocock/skills`

Paths are `skills/<entry>/SKILL.md` under the resolved package dir.

### Flow map / setup
- `engineering/ask-matt` — Matt's own router: how the skills chain into the idea→ship flow.
- `engineering/setup-matt-pocock-skills` — One-time setup (issue tracker, docs layout) the flow skills assume.

### Idea → spec → tickets → implement
- `engineering/grill-with-docs` — Relentless interview to sharpen a plan; maintains glossary + ADRs (needs a codebase).
- `productivity/grill-me` — Same grilling, stateless, no codebase required.
- `engineering/wayfinder` — Map a large, unclear, multi-session effort as decision tickets; hand off to a spec when the route is clear.
- `engineering/to-spec` — Synthesize the current conversation into a spec and publish it to the configured issue tracker.
- `engineering/to-tickets` — Split a spec, plan, or conversation into tracer-bullet tickets with explicit blocking edges.
- `engineering/implement` — Implement a spec or ticket: TDD at pre-agreed seams, typechecks, review, commit.
- `engineering/prototype` — Throwaway prototype to answer one design question (state model, UI feel).
- `engineering/research` — Background primary-source research captured as a cited Markdown file.

### Architecture / domain language
- `engineering/codebase-design` — Deep-module vocabulary: depth, seams, interfaces, adapters, locality, leverage.
- `engineering/domain-modeling` — Sharpen domain terms, maintain `CONTEXT.md`, record ADRs.
- `engineering/improve-codebase-architecture` — Scan for deepening opportunities, present as HTML report.

### Verify / review / maintain
- `engineering/tdd` — Seam-focused red→green loop; anti-patterns (tautological tests, horizontal slicing).
- `engineering/diagnosing-bugs` — Build a tight red feedback loop first, then reproduce→minimise→fix.
- `engineering/code-review` — Two-axis review (Standards + Spec) of a diff since a fixed point, parallel sub-agents.
- `engineering/triage` — Move incoming issues/external PRs through triage roles into agent-ready briefs.
- `engineering/resolving-merge-conflicts` — Conflict resolution workflow.

## Addy index — `addyosmani/agent-skills`

Paths are `skills/<entry>/SKILL.md` under the resolved package dir.

### Upstream (intent → spec → plan)
- `interview-me` — Extract real intent when the ask is underspecified.
- `idea-refine` — Diverge/converge on vague ideas before committing to a plan.
- `spec-driven-development` — Write a spec before coding for new projects/features.
- `planning-and-task-breakdown` — Break a spec into ordered, implementable tasks.

### Implementation
- `incremental-implementation` — Land multi-file changes in reviewable increments.
- `context-engineering` — Configure rules/context when agent output degrades.
- `source-driven-development` — Ground decisions in official docs / cited sources.
- `doubt-driven-development` — Adversarial fresh-context review for high-stakes or unfamiliar code.
- `api-and-interface-design` — Designing APIs, module boundaries, type contracts.
- `frontend-ui-engineering` — Production-quality UI components, layout, state.

### Verification
- `test-driven-development` — Drive logic/bug-fix/behavior change with tests (pyramid, sizes).
- `browser-testing-with-devtools` — Real-browser tests via Chrome DevTools MCP.
- `debugging-and-error-recovery` — Systematic root-cause debugging (reproduce→localize→fix→guard).
- `code-review-and-quality` — Five-axis review before merging.
- `code-simplification` — Refactor for clarity without behavior change.
- `security-and-hardening` — Untrusted input, auth, storage, third-party integrations.
- `performance-optimization` — Bottlenecks, regressions, Core Web Vitals.

### Delivery
- `git-workflow-and-versioning` — Commits, branches, conflicts, parallel streams.
- `ci-cd-and-automation` — Build/deploy pipelines, quality gates.
- `shipping-and-launch` — Pre-launch checklist, monitoring, staged rollout, rollback.
- `deprecation-and-migration` — Removing systems/APIs, migrating users.
- `documentation-and-adrs` — ADRs, decision records, durable docs.
- `observability-and-instrumentation` — Structured logs, metrics, traces, alerts.

## Maintenance

When either upstream package updates, re-sync this index by listing its `skills/` tree (resolved as above) and reconciling added/removed/renamed entries. Matt's repo also has `deprecated/`, `in-progress/`, `misc/`, and `personal/` categories — deliberately excluded here.
