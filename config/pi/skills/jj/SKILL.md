---
name: jj
description: "Prefer Jujutsu (`jj`) for VCS operations whenever `jj` is installed. The `jj.ts` extension warns when `git` is used directly. Working copy is auto-tracked. Run `jj <cmd> --help` or `jj help -k <topic>` for exact syntax — this skill stays at the concept/workflow layer on purpose."
---

## Policy

If `jj` is on the machine, `jj` is preferred. The `jj.ts` extension warns on
**every** `git` invocation (including read-only inspection and network ops),
because jj has natural equivalents for all of them and `jj st`/`jj log`/`jj diff`
surface jj-native state (change IDs, DAG, conflict markers) that git equivalents
hide.

- Colocated repo (`.jj/` present): use jj.
- Plain git repo (no `.jj/`): prefer adopting jj with `jj git init --colocate`.
- Using `git` directly still works but triggers a warning.

## Key differences from git

- **Working copy IS a change** (`@`) — no staging area; edits mutate `@` automatically.
- **Two IDs**: stable **change ID** (survives rewrites, prefer this) vs **commit ID** (git-compatible hash, churns on rewrite).
- **Conflicts are data, not control flow** — recorded in files, no command aborts, no `--continue` ceremony.

For deeper coverage: `jj help -k tutorial`.

## Looking up syntax

**Do not memorize flags — they drift across jj versions.** If unsure about
basic concepts or workflows, start with `jj help -k tutorial`. Always verify
exact flags against the installed version:

- `jj <cmd> --help` — flags + examples for one command
- `jj help -k <topic>` — conceptual topics (`tutorial`, `revsets`, `bookmarks`,
  `conflicts`, `working-copy`, `operation-log`, `git-compatibility`)
- `jj --help` — list of commands
- Git→jj translation: `jj help -k git-compatibility` and
  <https://docs.jj-vcs.dev/latest/git-command-table/>

## Agent-specific patterns

### Describe as plan
A multi-line `jj describe` message can carry the per-step plan and acceptance
criteria. `jj show` reads it back later. Write each change's description
first, then implement against it — this creates a self-driven loop without
an external task tracker.

### Pre-planning a multi-step task
Chain empty described changes (a sequence of `jj commit`) as a spec skeleton,
then `jj edit <first>` and fill them in one at a time. Descendants auto-rebase.

### Parallel exploration / workspaces
`jj workspace add <path>` — separate on-disk dir, shared store (cheap).
Each workspace develops a different change; all visible in `jj log`.
Done? `jj new a b` to merge, or pick one and `jj abandon` the other.

## PR review loop

This multi-step workflow isn't in any single help page:

1. **Fix the description** — `jj describe -r <change>`.
2. **Amend the diff** — `jj edit <change>` and edit, or `jj squash --into <change>`.
3. **Move the bookmark forward** — `jj bookmark move <name> --to <change>`.
4. **Re-push** — `jj git push`.

Your own published bookmark is in `mutable()` territory — amend + push is
safe, and the operation is in `jj op log`, so accidental rewrites are undoable.

## Common pitfalls

- **Push `@-`, not `@`** — `@` is typically empty after `jj commit`.
- **Bookmarks don't auto-advance** — you must `jj bookmark set/move` explicitly.
- Don't reach for `git` in a colocated repo; it bypasses `jj op log`.
- `jj abandon` drops a change and rebases descendants past it; it's undoable.

### Working-copy snapshot trap

Every jj command auto-snapshots `@` first — **all current disk state becomes
part of `@` before the command runs.** This bites hard with rewrites:

- `jj squash --from @` pulls the *entire* `@` into the target, not just
  files you edited in this session.
- `jj op restore` rewinds metadata but the working tree stays; the next
  snapshot lifts dirty files into whatever change is now `@`.

**Before any rewrite** (`squash`/`split`/`op restore`/`abandon` of ancestor):

1. `jj st` — read every line. Unexpected paths? Stop.
2. If `@` is mixed, `jj split <fileset>` first so each change is intentional.
3. For files that should never be tracked, `jj file untrack <path>` —
   `.gitignore` alone does nothing for already-tracked paths.
4. After `jj op restore`, run `jj st` immediately.

Warning sign: `--stat` shows a commit touching far more files than you
edited. That's working-copy contamination — abandon and redo with explicit
path args.
