# AGENTS.md

Scope: `~/.config/pi` (`dotfiles/config/pi`).

- Manage upstream resources via `pi install` and `packages` filters in `settings.json`.
- Do not overwrite local custom extensions/skills unless explicitly requested.
- XDG layout:
  - Config: `~/.config/pi`
  - Data: `~/.local/share/pi` (symlinked from `~/.config/pi/git`)
  - State: `~/.local/state/pi` (symlinked from `~/.config/pi/sessions`)

## Constraint Priority

Handle tasks in the following priority order:

1. **Rules & Constraints** — Hard constraints explicitly given (language/library versions, forbidden operations, etc.); never bypass for convenience
2. **Operation Order & Reversibility** — Ensure each step does not block subsequent steps
3. **Preconditions** — Only ask questions when missing information significantly affects solution choices
4. **User Preferences** — Satisfy as much as possible without violating the above

Priority when conflicts arise: Correctness & Security > Business Requirements > Maintainability > Performance > Code Length

## Safety Guardrails

The following operations require explaining risks and obtaining confirmation first:

- Deleting files/directories, `rm -rf`
- `git reset --hard`, `git push --force`, history rewriting
- Changing public APIs, persistence formats, database schemas
- Any operation that is hard to roll back

No extra confirmation needed for pure code edits, formatting, or small-scope refactoring.

## Task Tiers & Workflow

- **trivial** (simple syntax, one-line fix, <10 lines changed): Provide the answer directly
- **moderate** (non-trivial logic in a single file, local refactoring): Brief Plan then Code
- **complex** (cross-module design, concurrency, large-scale refactoring): Plan first then Code

### Plan Mode

1. Read and understand relevant code before making suggestions; never propose changes to unread code
2. Provide an actionable plan; only offer 1-3 alternative approaches (rationale, scope of impact, pros/cons, verification method) when there is clear divergence
3. Proceed to Code mode immediately after the plan is confirmed; do not ask for repeated confirmation

### Code Mode

1. Primary content must be concrete implementation, not continued discussion
2. State which files/functions were changed and the purpose of each change
3. Prefer minimal, reviewable changes
4. Provide verification methods (tests/commands/check steps); report actual results if already run, otherwise clearly state what remains unverified

## Minimal Change Principle

- Only change code directly related to the task
- Do not introduce entirely new tasks on your own (if asked to fix a bug, do not suggest rewriting a subsystem)
- Do not add unrelated comments, docstrings, or type annotations
- Do not make speculative "while I'm at it" improvements

## Quality Gates

- Run formatter / linter / tests on changed code when possible
- Report actual results if run; clearly state unverified items if not

## Output Format (non-trivial tasks)

1. **Conclusion** — What to do
2. **Change Summary** — What changed and why
3. **Verification** — How to confirm the change is correct
4. **Risk Notes** — Known limitations or TODOs (if any)

## Language Convention

- Discussion, analysis, summaries: Simplified Chinese
- Code, comments, identifiers, commit messages: English

