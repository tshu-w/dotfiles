---
name: jj
description: "Use Jujutsu (`jj`) for all VCS operations whenever `jj` is installed. The `jj.ts` extension blocks direct `git` commands by default; use `command git ...` to bypass when jj has no equivalent. Working copy is auto-tracked. Run `jj <cmd> --help` or `jj help -k <topic>` for exact syntax — this skill stays at the concept/workflow layer on purpose."
---

## Policy

If `jj` is on the machine, `jj` is the policy. The `jj.ts` extension blocks
**every** `git` invocation (including read-only inspection and network ops),
because jj has natural equivalents for all of them and `jj st`/`jj log`/`jj diff`
surface jj-native state (change IDs, DAG, conflict markers) that git equivalents
hide.

- Colocated repo (`.jj/` present): use jj.
- Plain git repo (no `.jj/`): adopt jj first with `jj git init --colocate`.
- If you really need raw git for a one-off, `command git ...` bypasses the
  guard. Use sparingly.

## Mental model

These are the load-bearing ideas; everything else follows from them.

- **Working copy IS a change** (`@`). Edits mutate `@` automatically. There
  is no staging area; new files are auto-tracked unless they match an ignore
  pattern.
- **Two IDs per change**: stable **change ID** (survives rewrites — prefer it
  for any reference) and **commit ID** (Git-compatible hash, churns when
  history is rewritten).
- **Operations are themselves a DAG** (`jj op log`). Almost everything is
  reversible via `jj undo` / `jj op restore`.
- **Conflicts are data, not control flow**: they are recorded into files but
  no command aborts. Edit the file to clear markers; jj picks up the
  resolution on the next command. No `--continue` ceremony.
- **Pushed history is immutable by default**: commits reachable from remote
  bookmarks are protected by the `immutable_heads()` revset; `jj edit` /
  `jj describe` on them errors out.
- **Bookmarks ≈ Git branches**, but they do *not* auto-advance with new
  commits — you must `jj bookmark set` (or `move`) explicitly before pushing.

## Workflow patterns

### Starting a task
Just edit. `@` is already your change. Set or refine its description any time
with `jj describe`.

### Saving progress and starting the next segment
`jj commit` seals `@` (with a message) and opens a fresh empty change on top.
Equivalent to `jj describe` + `jj new`.

### Pre-planning a multi-step task
Create a chain of empty described changes (a sequence of `jj commit`) as a
spec skeleton, then `jj edit <first>` and fill them in one at a time.
Descendants auto-rebase as you work.

### Side-quest / "stash"
There is no stash. `jj new @-` opens a fresh change on the parent of `@`,
leaving your current work as a sibling. Return with `jj edit <change>`.

### Editing a past change in place
`jj edit <change>`. Modifications amend that change; descendants auto-rebase.
If the change is immutable (reachable from a remote bookmark), jj refuses.

### Rewriting history
- `jj squash` — move the current change's diff into a parent (or arbitrary target).
- `jj split` — cut the current change into two along file/hunk boundaries.
- `jj absorb` — auto-distribute the current change's hunks back into the right
  ancestors based on which lines they touched.
- `jj rebase` — move a change (and optionally its descendants) onto another target.
- `jj arrange` — interactive reorder.

### Recovery
- `jj undo` — undo the last jj operation.
- `jj op log` + `jj op restore <op-id>` — deeper rollback to any prior repo state.
- `jj abandon <change>` — drop a change; descendants rebase past it.
- `jj restore [<paths>]` — discard working-copy edits (relative to `@`'s parent).

Pick by intent: `undo` reverses an action, `restore` cleans WC files,
`abandon` drops a change.

### Resolving conflicts
Edit the file to remove conflict markers; jj picks up the resolution on the
next command. Verify with `jj st`.

### Pushing to a Git remote
Bookmarks are jj's name for Git branches. Workflow:

1. Attach a bookmark to the change you want to publish — usually `@-`,
   because `@` is typically the open empty change.
2. Push that bookmark via `jj git push`.

Pulling and rebasing onto upstream: `jj git fetch`, then `jj rebase` onto the
relevant target (`trunk()`, or `<bookmark>@origin`).

## Looking up exact syntax

This skill deliberately avoids spelling out flag names because they drift
across jj versions (the destination flag for rebase / duplicate / revert
recently moved from `-d` to `-o`, for example). Always verify against the
installed version:

- `jj <cmd> --help` — flags + examples for one command
- `jj help -k <topic>` — conceptual topics (`tutorial`, `revsets`, `bookmarks`,
  `conflicts`, `working-copy`, `operation-log`, `git-compatibility`)
- `jj --help` — list of commands

When you need to translate a Git command, `jj help -k git-compatibility` and
the official command table at <https://docs.jj-vcs.dev/latest/git-command-table/>
are the source of truth.

## Common pitfalls

- `@` is the open working copy — typically empty after `jj commit`. **Push `@-`**,
  not `@`.
- Don't reach for `git` even when it would technically work in a colocated
  repo; it bypasses `jj op log` and breaks reversibility.
- Bookmarks don't auto-advance with new commits. You must move them.
- `jj abandon` is not "delete commit forever" — it drops a change and rebases
  descendants past it; the operation is itself in `jj op log` and undoable.
- Generated/ignored files are NOT auto-tracked even though everything else is.
- In a fresh checkout, the first thing you do is *not* `git status`; it's
  `jj st` (or just `jj`).

### Working-copy snapshot trap (read this twice)

Every jj command auto-snapshots `@` first. That means **all current disk
state — including unrelated edits you forgot about — becomes part of `@`
before the command runs.** Combined with rewriting commands this bites hard:

- `jj squash --from @ ...` pulls the *entire* current `@` (i.e. everything
  on disk that isn't ignored) into the target, not just the files you
  edited in this session.
- `jj op restore <op>` rewinds metadata but the working tree on disk
  doesn't move; the next snapshot lifts those disk files into whatever
  change is now `@`.
- Auto-generated files (e.g. jj's own per-repo metadata under
  `~/.config/jj/repos/<id>/`) silently get tracked the first time they
  appear under a tracked path. `.gitignore` only suppresses *new untracked*
  files; an already-tracked path keeps following the working tree.

Mandatory checks **before** any rewrite (`squash` / `split` / `move` /
`op restore` / `abandon` of an ancestor):

1. `jj st` and read every line. If any path is unexpected, stop.
2. If `@` is mixed (intended changes + drive-by edits), **first split `@`
   along filesets** so each remaining change is intentional, then rewrite.
   `jj split <fileset>` or `jj squash --from @ --into <target> -- <fileset>`
   are your scalpels; use them with explicit path arguments.
3. For files that should never be tracked (auto-generated metadata,
   editor caches), don't just edit `.gitignore` — also `jj file untrack
   <path>` to remove them from the current change. `.gitignore` alone
   does nothing for already-tracked paths.
4. When recovering with `jj op restore`, expect the next snapshot to
   reintroduce dirty disk files. Run `jj st` immediately after, not after
   five more commands.

Warning sign: a `--stat` shows a commit touching far more files than you
typed today. That's almost always working-copy contamination, not a real
intent. Abandon the contaminated change and redo with explicit path args.
