# pi-swarm

Pi-native recursive agent trees.

## Model tool

`agent` exposes four actions:

- `spawn`: start a child and return its ID immediately.
- `send`: continue a settled child, or queue a FIFO follow-up for a running child, on the same transcript.
- `wait`: wait for children without stopping them on timeout.
- `stop`: recursively stop a child subtree while preserving transcripts.

A parent can address only children it created. Running-child follow-ups execute in FIFO order; their settled turn results are delivered together after the queue drains. Child completions are delivered automatically unless a concurrent `wait` consumes them first.

## Command

`/agents` lists children with their status and cwd, plus accumulated model usage and cost for the whole root tree.

## Child runtime

V1 is implemented in `canopy.ts`:

- At most 3 child turns run concurrently across one root tree.
- Tree-level input/output/cache usage and cost are persisted without enforcing a token budget.
- Children default to a fresh context and the parent's cwd.
- `context: "fork"` copies the parent's current LLM context as a snapshot.
- Child active tools are the intersection of their available tools and the parent's active tools.
- Children load only `pi-swarm` and `pi-web` extensions. Other parent extensions are never imported into child runtimes.
- Project instructions, skills, prompts, themes, model, and thinking level use normal Pi resolution.

Child sessions are stored under:

```text
<Pi sessions root>/<encoded cwd>/subagents/
```

Child session files are materialized at spawn time, including fork snapshots, rather than waiting for the first assistant response. State is appended to the parent session as versioned `pi-swarm-child` custom entries. A process restart marks previously running children as stopped; their transcripts and queued follow-ups remain available. A later `send` resumes the preserved queue, while `stop` discards it.

## Testing

Tests live under `tests/`. Run them from this directory:

```bash
for test in tests/*.test.cjs; do node "$test" || exit; done
```
