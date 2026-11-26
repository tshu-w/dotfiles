# Local history regression (opt-in)

This script is excluded from `npm test`. Real samples retain all SDK-converted
system deltas and recorded tool declarations through `normalizeContext`. The
production bridge resolves the active system prompt and tool set, then separates
system from imported conversation history. No user extensions are loaded and all
tool execution is forbidden. Recorded declarations are not proof of current
runtime availability; dynamic hooks and real provider acceptance are not tested.
Only synthetic smoke uses authored fixture declarations. Actual requests retain
raw assistant records so production performs its own projection; the independent
oracle excludes failed assistant records with `stopReason` equal to `error` or `aborted`,
as SDK provider requests do. Omissions are counted by reason. Error tool results
remain, and missing/orphan receipts are never synthesized or discarded.

After metadata/layout/stop-reason validation, an assistant with exactly one
visible text block equal to `""` and no calls has no target step. Thinking plus
that single empty text is the same case; thinking-only is a different projection.
Whitespace, nonempty text, and empty leading text on a call message remain.
Unknown multi-text layouts and invalid metadata/stop reasons still reject.
`omittedEmptyAssistants` counts only such records in the final retained source
intervals, not either window gap, a rejected window, or an over-limit live prompt.
The source view, source indices, checkpoint ledger, and N/M counts retain these
records unchanged. The authored native probe established that the prior writer's
empty steps survived SQLite/Gen but vanished from HTTP, with every subsequent
nonempty message and call/result pair intact; production now omits those empty
steps directly. This is not a generic message-merge or whitespace normalization.

System records are model-facing content, including `sections`, not SDK-hidden
events. The active prompt is checked separately from history. Older results with
`excludedSystemMessages` used a fixed prompt/generic tools and are not equivalent
to the corrected recorded-system input. Byte metrics and the unchanged selection
proxy count message-content text plus serialized tool arguments, not system
sections or tool schemas. Active system-prompt bytes are reported separately.

Modes:

- `--self-test`: synthetic oracle checks; no files or network.
- `--verify-isolation`: twelve synthetic checks. A sandboxed process and its child
  must reach two local endpoints, bind/listen/roundtrip locally, and receive an
  explicit permission denial connecting to public `1.1.1.1:443`. Both must also
  receive permission denials reading and writing a self-created protected sentinel.
  The unconfined baseline must first pass those operations. These are eight network
  and four filesystem checks; no real profile is probed. The network check sends a
  TCP handshake only, no HTTP or payload; a timeout does not count as enforcement.
- `--inspect-admission`: read a fresh sample using the same selection rule, count
  SDK-converted roles, system provenance/content/sections/tool-delta categories,
  effective recorded system-prompt bytes and failed-assistant omissions, and call
  production `prepareHistory` in memory. No native process, model request, source
  write, payload dump, or source identifier output. Rejection diagnostics are
  fixed categories with anonymous sample ordinals. This new snapshot cannot be
  claimed identical to a previous run whose source snapshots were not retained.
- `--native-smoke`: synthetic end-to-end comparison and lifecycle observation. It first
  checks the sandbox, then uses a fixed long history through the production
  bridge/transport, including system sections, failed-assistant projection,
  a proactive source window, Unicode after user clipping, and multi-user live input with an independent
  separator block. Assistant/result Unicode must remain unchanged. It never
  enumerates real sessions. Add `--adjacent-users` for a separate authored ASCII
  fixture: three distinct historical users, one complete call/result group, and
  one current user. This observes Gen-to-HTTP framing without altering the decoder.
  Its exit status may remain nonzero while diagnosing a representation mismatch.
  `syntheticRoot` identifies the retained tree; `synthetic-comparison.json` contains
  the authored source, expected projection, captured requests, and framing. It
  contains no real session data. Alternatively, `--empty-assistants` adds two
  exact empty-text `stop` assistant records to that fixture: one between users,
  and one after the complete result group. It leaves admission and comparison
  unchanged, for observing whether SQLite, Gen, and HTTP retain empty records
  or parts and whether all subsequent nonempty content remains intact. Native attempts retain
  their private tree. Unproven worker cleanup is an information count, separate
  from the import/request comparison result and its exit status. Each synthetic
  case first imports and resumes a small neighboring session without dispatching
  a prompt. Its database and WAL/SHM bytes and complete existing `conversation_summaries` row
  must remain unchanged through the main import. The new imported summary row must
  also exist. Row presence alone does not prove all index fields are synchronized.
  These checks use only this case's private synthetic profile and its own IDs;
  shared indexes are never edited by the harness. Before host-side reads, index,
  session database, and optional WAL/SHM paths must be canonical ordinary files
  owned by this user, with one hard link, under the private case root; symlinks
  (including dangling auxiliary symlinks) are rejected.
- `--verify-default-profile`: **explicit real-account opt-in, run by the operator**.
  This uses the existing default profile and preserves the caller's environment;
  it does not inject fixture credentials or use the fake backend. Confirm that the
  profile is the intended consumer account, not an API-provider configuration.
  API-key/base-URL overrides and `AGY_ACP_BIN` are rejected, but the script does not
  inspect settings or credential contents to prove the configured account mode.
  See the zero-prompt procedure below. This mode is never invoked by the fake modes.
- `--run`: repeat isolation checks and the same synthetic smoke **before**
  enumerating real sessions. Exit 0 requires exactly 30 selected, processed, and
  passed cases. The prerequisite smoke has no request dump or detailed diagnostic
  output. The same aggregate JSON printed to stdout is also created as
  `runRoot/summary.json` with mode `0600` and exclusive creation (`wx`), including
  `prerequisiteSmoke`. This also covers a normally returned prerequisite failure;
  setup exceptions retain the fixed error output. No new payload fields are added.
  Perfect lifecycle proof is not required for a codec comparison.

`--run` reports one new private `runRoot` containing its prerequisite-smoke
and case directories. Native profiles with unproven worker state are retained;
the script does not clean them. Aggregate retained counts include the smoke, but
source/comparison and byte-distribution statistics cover only the real cases.
`retainedNativeBytes` includes measured native profile bytes from both.
A private `case-results.json` retains only anonymous ordinals, fixed difference
categories, import/system-check flags, retained-case counts, and anonymous numeric
projection/coalescing/declaration/known-difference statistics. Failed decoded
comparisons also retain `comparisonSummary`: canonical counts, zero-text/call-free
assistant counts, the first differing zero-based ordinal, and at most three
neighboring fixed role/part-kind/byte-count descriptions with HTTP Content
ordinals. The first mismatch uses the unchanged comparison predicate. No message
text, tool name, argument value, ID, hash, or real request body is retained in
this diagnostic. It contains no
source identifier, path, text, arguments, or hashes.

Result framing is decoded from independent native captures. Each run records its
own synthetic prerequisite result; an earlier smoke does not verify later oracle
or production changes. Every real run repeats isolation proof → synthetic native
smoke → real-history selection. Passing the network check alone cannot admit data.

## Real default-profile zero-prompt verification

The operator runs this same script with `--verify-default-profile` only after
confirming the existing consumer sign-in and approving creation of one native
session. Do not unlock, log in, copy tokens, or change credential storage as part
of this check. The harness does not read token contents, and no `authenticate` or
`session/prompt` RPC is dispatched. There is a 60-second abort budget; connection cleanup is awaited.
Normal native credential loading or refresh is outside the harness's observation.
Stopped creator/worker counters refer only to directly started processes;
`completeLifetimeProof` remains zero.

The production bridge performs single-process creator `session/new`, session close,
and awaited process close, then writes two fixed synthetic historical steps only to
its proven-new database. A normal worker resumes the same ID. After the actual
resume succeeds, the wrapper closes that session and connection and raises an
expected abort before model selection or prompt dispatch. Thus a successful result
has one new session, two written steps, one same-ID resume, and zero forbidden RPC
or tool attempts. `expectedCompletionAbort` must be one: the final result must carry
the fixed completion-abort marker after validation, with no cancellation signal.
Other aborts or timeouts cannot pass. No independent writer, ownership marker, title mutation, or
shared-index cleanup is introduced. Connection phases and RPC stages are checked
before dispatch: only one creator/new and one worker/same-ID resume are permitted;
repeated, concurrent, wrong-phase, or wrong-ID lifecycle RPCs are rejected before
they can create another real session.

Only the newly created database is read. Existing files in `conversations` are
compared by name, device/inode, size, mtime, ctime, and mode, including auxiliary
files. Metadata changes or unrelated additions make preservation verification
inconclusive (`existing_session_metadata_changed_unattributed`); concurrent native
activity is a possible cause, not proof that this check corrupted a session.
No existing session contents or real summary rows are read or compared. Exact
neighbor database/summary preservation is tested separately in the isolated fixture.

The anonymous result is printed and saved as `summary.json` (0600) under the new
private `verificationRoot`, which also retains the synthetic working directory.
The new imported session stays in the native default profile and can appear in
native `/resume`; the harness neither invents a title nor deletes it on failure.
This does not verify the `/resume` UI, a model response, or tool availability.
A fake-backend pass is never evidence that real account authentication works.

## Boundaries

The fake modes create private HOME/GEMINI directories and clear inherited
credentials/proxies. Before clearing the parent environment, it captures the OS
user's default `.gemini`, the parent HOME's `.gemini`, and any configured GEMINI_HOME,
including existing canonical aliases. Each case explicitly passes its own
`--gemini-dir` and uses its `antigravity-cli` default directory, without
`--app-data-dir`. Creator/worker and imported IDs are checked explicitly, not inferred
from the presence of a profile argument. Native launchers deny filesystem reads and
writes under those real profile paths; a missing guard fails closed. Only synthetic
sentinels test this rule, never a read or write probe against the real profile.
Under the accepted local-run policy, native processes and descendants run under
`sandbox-exec` with network denied except
local TCP bind/inbound and localhost outbound. Native internal RPC uses random
local ports; the earlier exact-port policy failed at creator `session/new` with
`bind_denied` before any native database existed. macOS's `localhost` filter also
allows on-host non-loopback interfaces; it is not a literal 127.0.0.1-only rule.
**Local forwarding proxies remain a route off-host**, so the successful direct
public-endpoint denial does not establish strong real-history confidentiality.
Real runs use this explicitly accepted residual-risk policy. A fixed-port proxy
still forwards to the production MCP server,
preserving body/auth and rewriting Host for its DNS-rebinding check. No tools or
permissions are reimplemented.

In `--run`, only after isolation and native smoke pass, select the latest 30 JSONL
files by mtime whose SDK-converted message-content text plus serialized tool arguments exceed
185,000 UTF-8 bytes. Skip malformed lines like Pi, migrate a clone in memory,
then call `buildSessionContext` on the last persisted leaf and default
`convertToLlm`. Do not call `SessionManager.open` or `loadEntriesFromFile`.
SDK branch/compaction/context-edit semantics remain authoritative. Admission
failures stay in the sample; do not substitute easier sessions.

The full transcript, including system records, reaches production normalization.
Before SDK folding, system content must be a string or known text/string blocks;
section values must be strings or null, and text must be well-formed UTF-16.
Unknown content fails as `system_source_shape` rather than disappearing in SDK
text extraction. The SDK's active system text is the oracle source, checked against
an independent snapshot before projection. The oracle independently omits structured
`preamble` and `docs` sections matching the approved Pi-default shapes: the one-line
Pi harness identity and its help sentence, and the Pi documentation heading with
one or more bullet lines inside `<docs>`. Matching is by shape, not provenance;
a custom section that still matches is also omitted. Opaque content and nonmatching
sections remain exact. Null sections contribute no text. These checks apply after
SDK system-delta folding, without importing the production matcher. Reported system
bytes still measure the recorded active source before this filtering.
The remaining content and sections must match the worker ACP append. Only approved
tool-name prefix mappings inside `tools`, `rules`, and `skills` are allowed and counted. The complete append
must be the exact suffix of the native single-text `systemInstruction`, immediately
after the independently captured native communication-style boundary. Unknown Pi
content changes or unverified framing fail. Old system versions are resolved by
the SDK, never concatenated indiscriminately.

The independent window oracle uses the approved `{revision: 4, maxBytes: 500000}`
policy, never production prepared steps. The complete filtered prefix is validated
before window selection. Budget cost is projected historical text plus each
call's serialized arguments once, plus current ACP text including inter-message
LF2. It includes existing clipping markers and call-leading text, but excludes
names, IDs, structure, image data, the native error prefix, system, and schemas.
The current 185,000-byte prompt guard takes precedence. Successful dispatch of
an oversized prompt or admission of an empty rendered prefix is an explicit
bypass failure, not an unchanged-window success.

If the full history fits, no marker is added. Otherwise only the first message of
a consecutive source-user run is a cut point; select the earliest fitting suffix.
`N` is its index in the complete filtered source prefix, including thinking-only
assistant records omitted from rendering. Prepend `[Pi omitted N earlier messages]`
and two LF bytes to the retained user's **original** caption/body, then apply
its single 185,000-byte projection. Never clip an already-clipped caption again.
Image data stays unchanged. The marker counts toward the budget.

Only when every complete-round candidate fails, retain the latest round's entire
consecutive user segment and choose the earliest fitting suffix of complete
visible assistant groups. A group contains nonempty assistant text or calls,
including all leading text, every call, and every adjacent matching result.
Thinking-only/empty-text assistants do not substitute for the last visible group.
At least one earlier visible group must be omitted; the last visible group and
its trailing hidden/empty records remain. No call batch may be split.

Append `\n\n[Pi omitted M intermediate messages]\n\n` to the **last** retained user's
original body/caption. `M` counts the source gap between the user segment's end
and the first retained group's source index, including hidden records in that
gap. The old prefix gap `N` and the middle gap `M` are disjoint. If both markers
belong to one user, compose head + original body + tail and project it once;
never reclip an already-clipped target. All markers count toward 500,000 bytes.
Reject explicitly if the user segment plus the last complete visible group
cannot fit; never delete the user segment or all visible groups. The checkpoint
ledger still describes the complete filtered history, not either retained gap.

`proactiveTrimming.wholeTurn` and `.intraTurn` separately report expected cases,
source-message counts, and dropped pre-marker target bytes. Their source counts
do not overlap; their case counts can overlap. Verified cases require the entire
independently expected model history to match. Expected statistics alone do not
prove production applied the projection. Dropped bytes are target text/args, not
raw source bytes. Whole-turn marker net bytes compare head-only user projection
to unmarked user projection; intra-turn marker net bytes compare the final
head+tail user projection to head-only projection. These signed adjustments are
accounting comparisons, not two actual clipping passes. Native additional
prefix loss, unknown priming, or any unapproved second truncation still fails.
The byte policy is not a universal token bound.

Expected history roles/text/arguments/order/ID mappings come from Pi messages, not
`prepareHistory`. Exact text or explicitly approved UTF-8 head/tail truncation is
checked independently: historical user text has a 185,000-byte budget;
assistant text stays exact (including leading text in call batches). Tool success
has 49,152 bytes; tool error has 49,115 before the native 37-byte
error envelope. The current new-user suffix has no historical truncation
allowance. For the current text-only live suffix, source user blocks independently
define expected ACP blocks: two LF bytes are a separate block between source
messages, never between text blocks within one message. The actual ACP prompt
must match every source-derived block and its order. Only that live suffix maps
to one native step with strict text concatenation; imported messages never merge.
Source-user/native-live-step/coalescing/separator-byte counts are reported.
Image-bearing layouts retain their original strict part/message comparison; no
unprobed cross-message image/text reordering is allowed. Old direct-concatenation
captures do not prove the new separator strategy. Every budgeted text must match
its exact independently projected source target, including UTF-8 head/tail quotas
and omission count; balanced-end bounds alone are insufficient. Extra trimming
fails even if its updated count is internally consistent. Tool images use the explicit
`[Pi omitted an image]` substitution. Byte clipping uses
`\n\n[Pi omitted N bytes]\n\n`. Counts of one use `byte` or `message` in all
counted markers; marker bytes remain part of the same exact budget calculations.

The independent oracle also derives the five import-loss counts from the final
retained source intervals: `userTruncated`, `toolResultsTruncated`,
`earlierMessagesOmitted`, `intermediateMessagesOmitted`, and `toolImagesOmitted`.
Messages inside either omitted gap are not counted again for truncation or
images. User truncation is evaluated after composing both markers on original
text; result images are counted from original image blocks, never by searching
for placeholder text. Production `prepareHistory` now returns `{ steps, losses }`;
neither field is used to construct the oracle. `expectedHistoryLosses` reports
these source-derived counts. `historyLossReporting` counts expected, actual, and
verified bridge `onImport` reports: a dispatched cold import with any positive
loss must report exactly once with the exact five counts; zero losses must not
report. Missing, duplicate, unexpected, or changed reports fail as
`history_loss_report`. Only counts are retained, not arbitrary callback payloads.
This checks the bridge report, not extension notification rendering or visibility.

`knownDifferences.native_user_unicode_removal` reports text, character, and byte
counts separately from failures. Imported and pure-live probes on the tested
native build/model both removed precisely U+E000, U+F8FE, U+F8FF, U+200C, U+200D,
and U+200E from user text. After constructing the approved clipped target (using
original byte-count digits and floor/ceil UTF-8 head/tail quotas), the oracle may
remove **all** occurrences of only those six codepoints and requires the remaining
entire text to match. It never cleans actual output or changes omission counts.
Unchanged text still passes normally. Partial removal, unknown codepoints, extra
changes, and applying this rule to assistant/result/system text are not allowed.
This is an explicitly reported loss, not original-byte fidelity or a general
Co/Cf normalization guarantee. Structural/framing failures remain failures.

Regression counters and target-model markers do not establish that a user saw a
Pi UI notification. This harness does not load user extensions or render the TUI.
Empty/thinking omissions and native Unicode removal are outside the five import
losses. Original Pi records remain available for inspection or a different
model's compaction path, but replaying the same native path does not guarantee
restoration of omitted context or deleted codepoints.

The exact budget errors are:
- `Antigravity cannot fit the latest turn. Compact with another model or start a new conversation.`
- `Antigravity input exceeds 185 KB. Use another model for this request.`

Native error envelopes and single-LF result-block joining follow independent
synthetic captures. Native function responses use the `model` envelope role;
part type supplies the tool-result semantics. Parallel assistant call batches
remain intact. Only a complete adjacent result set with unique source IDs may be
placed in its own call-batch order, matching the approved native representation.
Missing, duplicated, or foreign pairs are not normalized away.
User frames must match the captured `USER_REQUEST`/`ADDITIONAL_METADATA` layout,
with their timestamp matching the corresponding read-only native step's M1.1.
Only the exact captured Model Selection notice on a live user step is admitted.
One trailing restart notice may be removed only when its complete text matches
this run's persisted type-101/P114.1 line in the captured fixed outer frame, with
exact sender, priority, and restart body. Unknown or misplaced runtime annotations
fail; arbitrary user messages are never removed. The as-of-read source byte prefix
and original in-memory messages must
remain unchanged. External appends are counted separately; any prior byte change
or truncation rejects the sample as `source_changed`. No source is written or
locked. A trailing non-system user message is reused, or a fixed request is appended;
trailing system deltas are preserved without adding an unnecessary user message.

Real payloads stay in memory except private native persistence. Output contains
only aggregate counts, ratios, fixed difference categories, and the new runRoot
path; never source paths, source/native session IDs, real payloads, hashes, or stacks. Synthetic smoke additionally reports the
first failure's fixed stage, allowlisted error name/code, and only a known fixed
provider message when matched exactly. Native logs are classified in memory as
bind/connect/database failures; raw logs are never emitted. With explicit
synthetic-only authorization, comparison failures also report zero-based
canonical message/part indices, roles, UTF-8 byte lengths, SHA-256 hashes, and
first differing byte offsets. Synthetic smoke saves `synthetic-comparison.json`
(source fixture, independent expected projection, actual requests) mode 0600 in
its private root so further diagnosis does not require another native run.
Only explicit `--native-smoke` enables that file and detailed output; the
prerequisite smoke inside `--run` does not. No real payload, hash, location
diagnostic, or exception message is persisted or
emitted by that synthetic-only branch. After closing sessions and transports, parent exit
alone does not prove detached workers stopped.
The script does not infer process ownership from command-line text or session
IDs and sends no signals to inferred PIDs. The synthetic observer captures its
own production spawn handle, applies `detached: true` for a dedicated parent
process group, and reads only kernel PID/PPID/PGID/birth-time fields. It follows
observed parent-child identities around creator/worker new, resume, close, and
transport close. Output reports per-stage live direct/descendant counts, group
changes, and observed departures; IDs and timestamps stay in memory. This
special launch condition is not an observation of unmodified production launch.
Snapshots can miss detached descendants: `completeLifetimeProof` is always zero.

Under the explicitly acknowledged localhost proxy/port-reuse risk, listeners
close after transport close is requested/awaited; this does not prove every
worker stopped. Native profiles remain, and cleanup uncertainty is informational.
The real-mode checks are regression prerequisites, not a strong confidentiality
boundary or evidence that all native workers exited.
A setup failure before native launch can remove its own tree.

Profile size measurements count regular-file logical bytes only within the
native app-data profile; symlinks and unrelated probe artifacts are excluded.
Stages are empty-creator close, after history write before resume, after the
model turn, and after transport close. These are point-in-time measurements,
not atomic disk snapshots or proof that unobserved workers stopped. Aggregate count/min/median/max/total are collected alongside source
visible bytes. Missing stages remain missing rather than reporting zero. Totals
show per-rebuild accumulation; no automatic GC or cleanup policy is introduced.
