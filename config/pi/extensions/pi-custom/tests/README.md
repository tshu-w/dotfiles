# Pi-custom integration tests

Run the tape/Codex suite against the installed Pi and local pi-tape checkout:

```sh
node --test tests/tape-compaction.test.cjs
```

The default tape entry point is `~/.config/pi/git/github.com/tshu-w/pi-tape/extensions/index.ts`. Set `PI_TAPE_EXTENSION` to test another checkout.

The suite loads both real extension entry points with Pi's loader and exercises its runner, in-memory SessionManager, message conversion, and compaction implementation. Authentication and provider transports are stubbed; it makes no live API calls. Settings and tape data use an isolated temporary agent directory.

Coverage includes both load orders, discarded-history exclusion, effective pre-compaction token usage, split-turn requests and tool results, text fallback when custom is absent/disabled or remote setup/request fails, overflow recovery, per-session settings isolation, and a new Anchor superseding an older remote artifact.

Reload coverage emits shutdown/start events and reloads factories through the real loader; it does not drive the interactive `/reload` command. Removing custom must not resolve credentials through a stale adapter. A separate SDK-runner overlap case checks that a late shutdown cannot unregister a replacement using the same SessionManager.

The GC regression runs first and starts a fresh Node process with `--expose-gc` when needed. It checks that a shutdown runtime can be collected while a second session remains live. Cleanup hooks deliberately do not retain the observed runner. The default command above includes this check.

Bridge behavior is covered here through real runners and provider requests rather than duplicate one-sided bridge mocks.
