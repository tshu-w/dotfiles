# Protocol Reference

Prefer non-debugger methods first. `chrome.debugger`-backed methods (marked **CDP** below) can cause Chrome to show its native "started debugging this browser" banner, so use them only when DOM/content-script methods cannot answer the question.

## Access Model

1. The user turns Browser Bridge on for one browser window.
2. Default routing follows the active tab in that enabled window.
3. Use `tabId` only when you intentionally need a different tab in the same enabled window.
4. Turning Browser Bridge off removes access immediately.

If a call fails with `ACCESS_DENIED`, `TAB_MISMATCH`, or a routing error: confirm the user enabled Browser Bridge for the correct window, confirm the page is not a Chrome-restricted page, and fall back to default routing when you do not need a specific tab.

## Target Shapes

Browser Bridge currently supports two target styles:

- `selector` at the top level for subtree discovery methods such as `dom.query`, `dom.find_by_text`, `dom.find_by_role`, and `dom.wait_for`
- `target: { elementRef, selector }` for interaction-oriented methods and, as a backward-compatible alias, for element-level reads such as `dom.describe`, `dom.get_text`, `dom.get_attributes`, `dom.get_html`, `layout.get_box_model`, `styles.get_computed`, `styles.get_matched_rules`, and `screenshot.capture_element`

Legacy top-level `elementRef` still works for element-level reads. Prefer `target` for new integrations when you want one consistent shape across reads and interactions.

## Capability Mapping

The table below includes the legacy capability bucket for each method so agents do not need to cross-reference a separate coverage page.

- `-` means the method is global/system-scoped and was never gated by a former capability bucket.
- Capability names are descriptive coverage labels only. Browser Bridge access is window-scoped now; there are no capability-scoped sessions.

## All Methods (59)

| #   | Method                             | Tab? | CDP? | Group       | Capability           | Notes                                                                   |
| --- | ---------------------------------- | ---- | ---- | ----------- | -------------------- | ----------------------------------------------------------------------- |
| 1   | `access.request`                   | No   | -    | system      | `-`                  | Request window access; surfaces Enable prompt in extension UI           |
| 2   | `tabs.list`                        | No   | -    | tabs        | `-`                  | Discover available tabs                                                 |
| 3   | `tabs.create`                      | No   | -    | tabs        | `tabs.manage`        | Open a new tab; optional `url` and `active`                             |
| 4   | `tabs.close`                       | No   | -    | tabs        | `tabs.manage`        | Close a tab by `tabId`                                                  |
| 5   | `skill.get_runtime_context`        | No   | -    | system      | `-`                  | Live budget presets + method groups                                     |
| 6   | `setup.get_status`                 | No   | -    | system      | `-`                  | Global MCP config + CLI skill install status                            |
| 7   | `setup.install`                    | No   | -    | system      | `-`                  | Install or uninstall MCP/skill integration targets                      |
| 8   | `health.ping`                      | No   | -    | system      | `-`                  | Connectivity check + access routing state                               |
| 9   | `log.tail`                         | No   | -    | system      | `-`                  | Recent bridge logs                                                      |
| 10  | `daemon.metrics`                   | No   | -    | system      | `-`                  | Daemon health and performance metrics                                   |
| 11  | `page.get_state`                   | Yes  | -    | page        | `page.read`          | URL, readiness, focus, scroll, viewport                                 |
| 12  | `page.evaluate`                    | Yes  | CDP  | page        | `page.evaluate`      | JS expression in page context; last resort                              |
| 13  | `page.get_console`                 | Yes  | -    | page        | `page.read`          | Buffered console messages; filter by `level`, `limit`                   |
| 14  | `page.wait_for_load_state`         | Yes  | -    | wait        | `page.read`          | Block until tab `complete`; `timeoutMs` capped 30 s                     |
| 15  | `page.get_storage`                 | Yes  | -    | page        | `page.read`          | `localStorage`/`sessionStorage`; optional `keys`                        |
| 16  | `page.get_text`                    | Yes  | -    | page        | `page.read`          | Full page text; `textBudget` limits size                                |
| 17  | `page.get_network`                 | Yes  | -    | page        | `network.read`       | Intercepted fetch/XHR; `limit` entries                                  |
| 18  | `navigation.navigate`              | Yes  | -    | navigate    | `navigation.control` | Go to URL; `waitForLoad` default true                                   |
| 19  | `navigation.reload`                | Yes  | -    | navigate    | `navigation.control` | Reload; `waitForLoad` default true                                      |
| 20  | `navigation.go_back`               | Yes  | -    | navigate    | `navigation.control` | History back                                                            |
| 21  | `navigation.go_forward`            | Yes  | -    | navigate    | `navigation.control` | History forward                                                         |
| 22  | `dom.query`                        | Yes  | -    | inspect     | `dom.read`           | Query subtree with budget constraints                                   |
| 23  | `dom.describe`                     | Yes  | -    | inspect     | `dom.read`           | Single element details via `elementRef`                                 |
| 24  | `dom.get_text`                     | Yes  | -    | inspect     | `dom.read`           | Text content with `textBudget`                                          |
| 25  | `dom.get_attributes`               | Yes  | -    | inspect     | `dom.read`           | Targeted attribute read                                                 |
| 26  | `dom.wait_for`                     | Yes  | -    | wait        | `dom.read`           | Wait for DOM condition; MutationObserver + polling                      |
| 27  | `dom.find_by_text`                 | Yes  | -    | inspect     | `dom.read`           | Find by visible text; returns `{nodes, count}`                          |
| 28  | `dom.find_by_role`                 | Yes  | -    | inspect     | `dom.read`           | Find by ARIA role; optional `name` filter                               |
| 29  | `dom.get_html`                     | Yes  | -    | inspect     | `dom.read`           | `innerHTML`/`outerHTML`; `maxLength` truncation                         |
| 30  | `dom.get_accessibility_tree`       | Yes  | CDP  | inspect     | `dom.read`           | Full a11y tree; `maxNodes`/`maxDepth` limits                            |
| 31  | `layout.get_box_model`             | Yes  | -    | inspect     | `layout.read`        | Element geometry (no budget needed)                                     |
| 32  | `layout.hit_test`                  | Yes  | -    | inspect     | `layout.read`        | Element at viewport point                                               |
| 33  | `styles.get_computed`              | Yes  | -    | inspect     | `styles.read`        | Computed CSS; always set `properties`                                   |
| 34  | `styles.get_matched_rules`         | Yes  | -    | inspect     | `styles.read`        | Matching CSS rules                                                      |
| 35  | `viewport.scroll`                  | Yes  | -    | navigate    | `viewport.control`   | Window or element scroll                                                |
| 36  | `viewport.resize`                  | Yes  | CDP  | navigate    | `viewport.control`   | Set viewport via device emulation; `reset: true`                        |
| 37  | `input.click`                      | Yes  | -    | interact    | `automation.input`   | DOM-level click                                                         |
| 38  | `input.focus`                      | Yes  | -    | interact    | `automation.input`   | Focus element                                                           |
| 39  | `input.type`                       | Yes  | -    | interact    | `automation.input`   | Type into input/textarea/contenteditable                                |
| 40  | `input.press_key`                  | Yes  | -    | interact    | `automation.input`   | Single key event                                                        |
| 41  | `input.set_checked`                | Yes  | -    | interact    | `automation.input`   | Checkbox/radio toggle                                                   |
| 42  | `input.select_option`              | Yes  | -    | interact    | `automation.input`   | Native select by value/label/index                                      |
| 43  | `input.hover`                      | Yes  | -    | interact    | `automation.input`   | mouseenter/mouseover/mousemove; optional `duration`                     |
| 44  | `input.drag`                       | Yes  | -    | interact    | `automation.input`   | Full drag-and-drop event sequence                                       |
| 45  | `input.scroll_into_view`           | Yes  | -    | interact    | `automation.input`   | Explicitly scroll target into view before inspect/capture               |
| 46  | `screenshot.capture_element`       | Yes  | CDP  | capture     | `screenshot.partial` | Cropped element screenshot                                              |
| 47  | `screenshot.capture_region`        | Yes  | CDP  | capture     | `screenshot.partial` | Cropped viewport region                                                 |
| 48  | `screenshot.capture_full_page`     | Yes  | CDP  | capture     | `screenshot.partial` | Full document screenshot; use only when page-level context is necessary |
| 49  | `patch.apply_styles`               | Yes  | -    | patch       | `patch.styles`       | Reversible CSS patch; `verify` returns computed result                  |
| 50  | `patch.apply_dom`                  | Yes  | -    | patch       | `patch.dom`          | Reversible DOM mutation; `verify` returns result                        |
| 51  | `patch.list`                       | Yes  | -    | patch       | `patch.dom`          | Active patches                                                          |
| 52  | `patch.rollback`                   | Yes  | -    | patch       | `patch.dom`          | Revert one patch                                                        |
| 53  | `patch.commit_session_baseline`    | Yes  | -    | patch       | `patch.dom`          | Accept current state as baseline                                        |
| 54  | `performance.get_metrics`          | Yes  | CDP  | performance | `performance.read`   | Chrome performance counters                                             |
| 55  | `cdp.get_document`                 | Yes  | CDP  | cdp         | `cdp.dom_snapshot`   | DevTools document tree                                                  |
| 56  | `cdp.get_dom_snapshot`             | Yes  | CDP  | cdp         | `cdp.dom_snapshot`   | DevTools DOM snapshot                                                   |
| 57  | `cdp.get_box_model`                | Yes  | CDP  | cdp         | `cdp.box_model`      | DevTools-backed element geometry                                        |
| 58  | `cdp.get_computed_styles_for_node` | Yes  | CDP  | cdp         | `cdp.styles`         | DevTools-backed computed styles                                         |
| 59  | `cdp.dispatch_key_event`           | Yes  | CDP  | cdp         | `cdp.input`          | DevTools keyDown/keyUp without foreground focus                         |

## CLI

```bash
bbx status | doctor | restart | logs | tabs | skill # no routed tab needed
bbx call <method> '{"key":"val"}'           # generic RPC (routes to active tab in enabled window)
bbx call --tab 123 <method> '{...}'         # explicit tab target inside enabled window
bbx batch '[{"method":"...","params":{}}]'  # parallel calls
```

**Convenience shortcuts:** `access-request`, `dom-query`, `describe`, `text`, `styles`, `box`, `click`, `focus`, `type`, `press-key`, `cdp-press-key`, `patch-style`, `patch-text`, `patches`, `rollback`, `screenshot`, `eval`, `console`, `wait`, `find`, `find-role`, `html`, `hover`, `navigate`, `storage`, `tab-create`, `tab-close`, `page-text`, `network`, `a11y-tree`, `perf`, `scroll`, `resize`, `reload`, `back`, `forward`, `attrs`, `matched-rules`

Newer bridge methods such as `input.scroll_into_view` and `screenshot.capture_full_page` currently use the raw path: `bbx call <method> '{...}'`.

## Method Details

### access.request

Request Browser Bridge access for the focused browser window. Surfaces an Enable prompt in the extension popup or side panel so the user can grant access. Does not require an existing session.

```bash
bbx access-request
bbx call access.request
```

If a tab-bound call returns `ACCESS_DENIED`, it also surfaces the Enable prompt automatically — so explicit `access.request` is optional but useful for proactive setup.

If access is already pending for a window, do not call `access.request` again. Ask the user to click `Enable` for the requested window and wait for confirmation before continuing.

### page.evaluate

Run a JS expression in the page context via CDP `Runtime.evaluate`. Expression is evaluated as a statement and the return value is serialized. Supports `awaitPromise` for async expressions.

Use only when non-debugger reads are insufficient. Prefer `page.get_storage`, `page.get_text`, `page.get_console`, `page.get_network`, or DOM methods first.

```bash
bbx eval 'document.title'
bbx eval 'window.__NEXT_DATA__.props'
bbx call page.evaluate '{"expression":"await fetch(\"/api/health\").then(r=>r.json())","awaitPromise":true}'
```

### page.get_console

Read buffered console output. The console interceptor is auto-installed on first call. Captures `log`, `warn`, `error`, `info`, `debug` plus uncaught exceptions and unhandled rejections.

```bash
bbx console                    # all levels
bbx console error              # errors only
bbx call page.get_console '{"level":"error","limit":20,"clear":true}'
```

Responses include `dropped` when older buffered entries were discarded on noisy pages.

### page.wait_for_load_state

Block until the tab reaches `complete` status. Useful after `input.click` on a navigation link.

```bash
bbx call page.wait_for_load_state '{"timeoutMs":10000}'
```

### page.get_storage

Read `localStorage` or `sessionStorage` entries. Values truncated at 500 chars each.

```bash
bbx storage                        # all localStorage
bbx storage session token,user     # specific sessionStorage keys
bbx call page.get_storage '{"type":"session","keys":["token"]}'
```

### dom.query

Run a bounded breadth-first DOM summary rooted at a selector or existing ref. Returns `{nodes, revision, truncated, registrySize}` and may also include `_registryPruned: true` when the element registry evicted older refs.

```bash
bbx dom-query main
bbx call dom.query '{"selector":"main","maxNodes":10,"attributeAllowlist":["class","data-testid"]}'
```

If `_registryPruned` is true, refresh previously cached refs before reusing them.

### dom.wait_for

Wait for a DOM condition using MutationObserver + 250 ms polling fallback. Returns `{found, elementRef, duration}`.

- `state`: `attached` (default), `detached`, `visible`, `hidden`
- `text`: optional text content filter
- `timeoutMs`: 100–30000 (default 5000)

```bash
bbx wait '.toast-success' 5000
bbx call dom.wait_for '{"selector":".modal","state":"visible","timeoutMs":10000}'
```

### dom.find_by_text

Find elements matching visible text content. Like Playwright's `getByText`.

```bash
bbx find 'Submit Order'
bbx call dom.find_by_text '{"text":"Submit","selector":"button","exact":false}'
```

### dom.find_by_role

Find elements by ARIA role (explicit `role` attribute or implicit from HTML tag). Covers 25+ implicit role mappings.

```bash
bbx find-role button 'Save'
bbx call dom.find_by_role '{"role":"navigation"}'
```

### dom.get_html

Get raw HTML of an element. Defaults to `innerHTML`; set `outer: true` for `outerHTML`.

```bash
bbx html el_abc123
bbx call dom.get_html '{"elementRef":"el_abc123","outer":true,"maxLength":2000}'
```

### input.hover

Trigger CSS `:hover` state by dispatching `mouseenter`, `mouseover`, `mousemove`. Optional `duration` to hold hover before auto-releasing.

```bash
bbx hover el_abc123
bbx call input.hover '{"target":{"elementRef":"el_abc123"},"duration":1000}'
```

### input.drag

Full drag-and-drop sequence: `mousedown → dragstart → drag → dragenter → dragover → drop → dragend → mouseup`. Accepts source target, destination target, and optional pixel offsets.

```bash
bbx call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"}}'
bbx call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"},"offsetX":10,"offsetY":10}'
```

### input.scroll_into_view

Explicitly scroll an element into the visible viewport before inspecting, hovering, or capturing it.

```bash
bbx call input.scroll_into_view '{"target":{"elementRef":"el_abc123"}}'
bbx call input.scroll_into_view '{"target":{"selector":"[data-testid=\\"checkout-summary\\"]"}}'
```

### tabs.create

Open a new browser tab. Optional `url` (defaults to `about:blank`) and `active` flag (defaults to `true`). Does not require a session.

```bash
bbx tab-create https://example.com
bbx call tabs.create '{"url":"https://example.com","active":false}'
```

The `bbx tab-create` shortcut intentionally covers the common case. Use `bbx call tabs.create ...` when you need advanced fields such as `active:false`.

### setup.get_status

Inspect the host-side Browser Bridge setup. Returns global MCP config status for supported clients and global CLI skill install status for supported targets.

```bash
bbx call setup.get_status
```

### tabs.close

Close a tab by its `tabId`. Does not require a session.

```bash
bbx tab-close 12345
bbx call tabs.close '{"tabId":12345}'
```

### page.get_text

Extract the full visible text content of the page (`document.body.innerText`). Truncated to `textBudget` (default 8000 chars). Lighter than `dom.query` on `body` when you only need text.

```bash
bbx page-text
bbx page-text 8000
bbx call page.get_text '{"textBudget":2000}'
```

### page.get_network

Read intercepted fetch/XHR requests. The interceptor is auto-installed on first call (via MAIN world script). Returns `{entries, count}` sorted newest-first.

```bash
bbx network
bbx network 50
bbx call page.get_network '{"limit":20,"clear":true}'
```

Each entry: `{method, url, status, duration, initiator}`. Responses include `dropped` when older buffered entries were discarded.

### dom.get_accessibility_tree

Retrieve the page's accessibility tree via CDP `Accessibility.getFullAXTree`. Each node is simplified to: `role`, `name`, `description`, `value`, `focused`, `required`, `checked`, `disabled`, `interactive`, `childIds`. Use `maxNodes` and `maxDepth` to control size.

This is debugger-backed. Prefer `dom.find_by_role`, `dom.find_by_text`, and targeted `dom.query`/`dom.describe` first.

```bash
bbx a11y-tree
bbx a11y-tree 50 3
bbx call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":5}'
```

### viewport.resize

Set the browser viewport to specific dimensions using CDP device emulation. Pass `reset: true` to clear the override.

Debugger-backed. Use only when an exact viewport override is required for responsive verification.

```bash
bbx resize 375 812
bbx call viewport.resize '{"width":1024,"height":768}'
bbx call viewport.resize '{"reset":true}'
```

### performance.get_metrics

Read Chrome performance counters via CDP `Performance.getMetrics`. Returns a flat `{metrics}` object with keys like `JSHeapUsedSize`, `LayoutCount`, `TaskDuration`, etc.

Debugger-backed. Use after lighter reads fail to explain a performance symptom.

```bash
bbx perf
bbx call performance.get_metrics
```

### screenshot.capture_full_page

Capture a full-document screenshot beyond the current viewport. Use only when element or tight region captures cannot express the issue. Chrome capture limits still apply on very large pages.

This raw call returns base64 JSON. Prefer `bbx screenshot <ref> [outPath]` when one element is enough.

```bash
bbx call screenshot.capture_full_page '{}'
```

## Request Envelope

```json
{
  "id": "req_1",
  "tab_id": 123,
  "method": "dom.query",
  "params": {},
  "meta": { "protocol_version": "1.0", "token_budget": 1200 }
}
```

## Error Codes

| Code                         | Action                                                         | Recovery                                     |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| `ACCESS_DENIED`              | Turn on Browser Bridge for the target window                   | `retry: false`                               |
| `TAB_MISMATCH`               | Explicit `tabId` is missing, closed, or outside enabled window | `retry: false`, use `tabs.list`              |
| `ELEMENT_STALE`              | Re-query DOM for fresh `elementRef`                            | `retry: false`, use `dom.query`              |
| `CONTENT_SCRIPT_UNAVAILABLE` | Page is restricted (chrome://, extensions, etc.)               | `retry: false`                               |
| `NATIVE_HOST_UNAVAILABLE`    | Check daemon: `bbx status`                                     | `retry: false`                               |
| `EXTENSION_DISCONNECTED`     | Extension not connected to daemon                              | `retry: true` after 3 s, check `health.ping` |
| `TIMEOUT`                    | Wait/evaluate exceeded `timeoutMs`                             | `retry: true` after 1 s                      |
| `RATE_LIMITED`               | Too many requests                                              | `retry: true` after 2 s                      |

Timeout on content-script request → use narrower `dom.query` or CDP fallback.
Timeout on navigation → increase `timeoutMs`, set `waitForLoad:false`, or check `page.get_state`.
Timeout on `dom.wait_for` → returns `{found: false}` (not an error); check selector/state logic.
