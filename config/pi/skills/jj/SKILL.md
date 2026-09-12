---
name: jj
description: "Prefer Jujutsu (`jj`) for VCS operations; covers differences from Git, optional workflows, and working-copy snapshot pitfalls."
---

## Policy

Prefer jj when it is installed.

- Colocated repo (`.jj/` present): use jj.
- Plain git repo (no `.jj/`): prefer adopting jj with `jj git init --colocate`.

## Key differences from git

- **Working copy IS a change** (`@`) — no staging area; edits mutate `@`
  automatically.
- **Two IDs**: stable **change ID** (survives rewrites, prefer this) vs
  **commit ID** (git-compatible hash, churns on rewrite).
- **Merge conflicts can be recorded in commits** and resolved later, without
  Git-style `--continue`.

For deeper coverage: `jj help -k tutorial`.

## Looking up syntax

When unsure about syntax, consult the installed version's help:

- `jj <cmd> --help` — flags + examples for one command
- `jj help -k <topic>` — concepts and workflows
- `jj --help` — list of commands
- Git→jj translation: <https://docs.jj-vcs.dev/latest/git-command-table/>

## Optional workflows

- **Record intent:** For long-lived changes, `jj describe` can record goals and acceptance criteria; use `jj show` to read them later.
- **Checkpoint work:** Inspect `jj st` before risky edits; when needed, commit or split only authorized changes and preserve unrelated modifications.
- **Plan a commit sequence:** For incremental delivery, optionally create described changes and fill them in one at a time; descendants auto-rebase.
- **Explore alternatives:** `jj new` creates a change; use `jj workspace add` for an independent on-disk workspace. Merge or abandon alternatives only within the authorized scope.
- **Undo or recover:** Inspect `jj log`/`jj op log` before choosing a recovery operation; consult the snapshot trap below before rewriting.

## PR review loop

1. **Fix the description** — `jj describe -r <change>`.
2. **Amend the diff** — `jj edit <change>` and edit, or
   `jj squash --into <change>`.
3. **Move the bookmark forward** — `jj bookmark move <name> --to <change>`.
4. **Re-push** — `jj git push`.

## Common pitfalls

- After `jj commit`, the committed change is usually `@-`; verify that the bookmark points to the intended change before pushing.
- **Bookmarks don't auto-advance** — you must `jj bookmark set/move` explicitly.
- Don't reach for `git` in a colocated repo; it bypasses `jj op log`.
- `jj abandon` drops a change and rebases descendants past it; it's undoable.
- `--ignore-working-copy` skips the auto-snapshot on read, but the result may
  be stale; avoid it in write workflows.

### Working-copy snapshot trap

By default, jj snapshots the working copy before a command and updates it
afterward if the command changed `@`.

- Default `jj squash` (i.e. `--from @`) pulls the *entire* `@` into the
  parent (or `--into <target>` for a non-parent destination), not just files
  you edited this session.
- `jj op restore` restores repository state and may update the working copy;
  inspect the target first with `jj --at-op=<operation ID> log`.

**Before any rewrite** (`squash`/`split`/`op restore`/`abandon` of ancestor):

1. Inspect `jj st` and the diff to establish the intended scope.
2. If unrelated changes are present, limit the file or diff scope; confirm authorization before splitting when needed.
3. After recovery, check `jj st` and the diff.

If the actual scope exceeds what was intended, inspect the operation log and
diff before deciding how to recover.
