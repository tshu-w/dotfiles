# Token Efficiency

## Budget Presets

| Preset | maxNodes | maxDepth | textBudget | Use When                                 |
| ------ | -------- | -------- | ---------- | ---------------------------------------- |
| quick  | 5        | 2        | 300        | Checking one element or confirming state |
| normal | 25       | 4        | 600        | General inspection (default)             |
| deep   | 100      | 8        | 2000       | Complex nested components                |

Always start at **quick** or **normal**; widen only if the result indicates truncation.

These presets are also available at runtime via `bbx skill`.

## Debugger Policy

Avoid debugger-backed methods until they are clearly necessary. In Browser Bridge, `page.evaluate`, `dom.get_accessibility_tree`, `viewport.resize`, `performance.get_metrics`, `screenshot.capture_*`, and `cdp.*` attach `chrome.debugger`, which can make Chrome show its native debugging banner across the running browser instance.

## Decision Tree

1. **Know the selector?** → `dom.query` with quick budget
2. **Know the visible text?** → `dom.find_by_text` (cheaper than query + scan)
3. **Know the ARIA role?** → `dom.find_by_role` (semantic, no selector guessing)
4. **Need one element's details?** → `dom.describe` with elementRef
5. **Need layout metrics?** → `layout.get_box_model` (no budget needed)
6. **Need styles?** → `styles.get_computed` with explicit `properties` list
7. **Need runtime errors?** → `page.get_console` with `level: 'error'`
8. **Need full page text?** → `page.get_text` (cheaper than `dom.query` on body)
9. **Need API call history?** → `page.get_network` (intercepted fetch/XHR log)
10. **Need framework/app state and no lighter read can expose it?** → `page.evaluate` (debugger-backed)
11. **Need semantic structure and role/text queries are insufficient?** → `dom.get_accessibility_tree` (debugger-backed)
12. **Need performance data?** → `performance.get_metrics` (debugger-backed)
13. **Testing responsive with an exact forced viewport?** → `viewport.resize` (debugger-backed)
14. **Visual ambiguity after structured reads?** → `screenshot.capture_element` first, or `screenshot.capture_region` with a tight crop when one element is not enough (debugger-backed)
15. **Content-script blocked?** → `cdp.get_document` or `cdp.get_dom_snapshot` (debugger-backed fallback)

## Allowlist Strategy

Always set allowlists when you know what you need:

```json
{
  "selector": ".card",
  "maxNodes": 10,
  "attributeAllowlist": ["class", "id", "href", "data-testid"],
  "textBudget": 400
}
```

Omitting allowlists or leaving the text budget wide open often returns 3–5× the tokens needed.

## Anti-Patterns (Token Waste)

| Pattern                                  | Cost                | Fix                                                                                          |
| ---------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `dom.query` on `body` with no budget     | ~2000 tok           | Use specific selector + quick budget                                                         |
| Screenshot before structured read        | ~1500 tok wasted    | Always `dom.query` or `styles.get_computed` first                                            |
| Re-querying DOM for same element         | ~500 tok/call       | Reuse `elementRef` from prior result                                                         |
| Full-page screenshot                     | ~3000 tok           | Use `screenshot.capture_element`, or `screenshot.capture_region` with a tight rect           |
| Requesting all computed styles           | ~800 tok            | Set `properties` list (usually 3–8 props)                                                    |
| Multiple CLI calls for independent reads | overhead/call       | Use `batch` command                                                                          |
| Guessing selectors for known labels      | ~300 tok wasted/try | Use `dom.find_by_text` or `dom.find_by_role`                                                 |
| Polling page state with repeated queries | ~500 tok/poll       | Use `dom.wait_for` (single call, waits async)                                                |
| Inspecting DOM to read app state         | ~800 tok            | Use `page.evaluate` to read JS directly                                                      |
| Re-querying after HMR without waiting    | ~500 tok stale      | `dom.wait_for` first, then query                                                             |
| Separate call to verify a patch          | ~500 tok wasted     | Set `verify: true` on `patch.apply_styles` / `patch.apply_dom` to get computed result inline |
| `dom.query` on body for page text        | ~2000 tok           | Use `page.get_text` (extracts innerText directly)                                            |
| Guessing interactive elements from DOM   | ~600 tok/try        | Use `dom.get_accessibility_tree` for semantic roles                                          |
| Fetching network via evaluate hacks      | ~400 tok            | Use `page.get_network` (auto-interceptor)                                                    |
| Full a11y tree with no limits            | ~3000 tok           | Set `maxNodes` ≤ 50, `maxDepth` ≤ 4                                                          |

## Efficient Loop

1. Query narrow subtree (quick budget).
2. Pick one `elementRef`.
3. Read only needed styles/layout.
4. Patch narrowly.
5. Check `page.get_console` if the behavior might be error-driven.
6. Verify with `layout.get_box_model` or `styles.get_computed`.
7. Escalate to debugger-backed methods only if the answer is still missing.
8. Screenshot only if structured evidence is ambiguous, and keep the capture partial.

## Evaluate Instead of DOM Scan

When you need app state (router, store, config), `page.evaluate` can be far cheaper than parsing DOM, but it is debugger-backed. Use it only after DOM, text, storage, console, and network reads still leave uncertainty:

```bash
# Read Next.js route - 1 call vs. parsing URL from dom.query on <head>
bbx eval 'window.__NEXT_DATA__?.page'

# Read React store state
bbx eval 'document.querySelector("[data-reactroot]")?.__reactFiber$?.memoizedState'

# Check feature flag
bbx eval 'window.__APP_CONFIG__?.features?.darkMode'
```

## Console for Error Detection

After interactions, check for runtime errors instead of guessing from DOM:

```bash
bbx console error    # just errors and exceptions
```

Install early - the buffer auto-activates on first call. Captured levels: log, warn, error, info, debug, exception, rejection.

## Page Text Instead of DOM Scan

When you need the page's visible text - for summarization, search, or content extraction - use `page.get_text` instead of `dom.query` on `body`:

```bash
bbx page-text           # default 8000 char budget
bbx page-text 8000      # larger budget for long pages
```

This is 3–5× cheaper than querying the body's subtree with `dom.query`.

## Network Monitoring

Check API calls without manual `page.evaluate` fetch interception:

```bash
bbx network              # recent fetch/XHR entries
bbx network 50           # last 50 entries
```

The interceptor auto-installs on first call. Each entry shows `method`, `url`, `status`, `duration`. Use `clear: true` to reset the buffer.

## Accessibility Tree for Semantic Discovery

When you need to understand the page's interactive structure without guessing selectors:

```bash
bbx a11y-tree 30 3       # 30 nodes, depth 3
```

Returns role/name/interactive flag per node. Much cheaper than screenshot + OCR, and more accurate than `dom.query` on generic selectors.

## Semantic finding Saves Selector Guessing

When you know the text label but not the selector, `find_by_text` and `find_by_role` skip the trial-and-error:

```bash
# Instead of guessing: dom.query '.btn-primary', '.submit-btn', 'button[type=submit]'...
bbx find 'Submit Order'   # finds it in one call

# Instead of dom.query 'nav', '.navigation', '#main-nav'...
bbx find-role navigation  # semantic, works regardless of classes
```

## HMR-Aware Waiting

After modifying source code, the dev server hot-reloads. Always wait before inspecting:

```bash
bbx wait '[data-component="Header"]' 5000   # wait for component re-mount
bbx console error                            # check for HMR errors
bbx eval 'module.hot?.status?.()'            # check HMR status (webpack)
```

## Parent-Agent Response Policy

The subagent should return:

- What was inspected (selector or elementRef)
- What changed (if patching)
- Whether it answers the question

Store oversized outputs as local artifacts; return path + summary only.
