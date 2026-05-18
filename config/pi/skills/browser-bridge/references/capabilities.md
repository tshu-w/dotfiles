# Access And Coverage Summary

Use this page only for the access model and routing rules.

The canonical per-method capability mapping now lives in [protocol.md](protocol.md), which includes a `Capability` column directly in the method table.

Browser Bridge does not use capability-scoped sessions anymore.

## Access Model

1. The user turns Browser Bridge on for one browser window.
2. Default routing follows the active tab in that enabled window.
3. Use `tabId` only when you intentionally need a different tab in the same enabled window.
4. Turning Browser Bridge off removes access immediately.

Once a window is enabled, the bridge can use all standard methods in that window, including debugger-backed methods when needed.

## Routing Defaults

Prefer default routing:

```bash
bbx status
bbx page-text
bbx dom-query main
```

If the user switches to another tab in the enabled window, Browser Bridge follows that tab automatically.

Use explicit `tabId` only for non-active tabs or deliberate side-by-side comparisons:

```bash
bbx tabs
bbx call --tab 123 page.get_text
bbx call --tab 456 dom.query '{"selector":"main"}'
```

In MCP tools, pass `tabId` for explicit targeting.

## Access Failures

If a call fails with `ACCESS_DENIED`, `TAB_MISMATCH`, or another routing error:

1. Confirm the user enabled Browser Bridge for the correct browser window.
2. Confirm the target page is a normal web page, not a Chrome-restricted page.
3. If using explicit `tabId`, confirm that tab is inside the enabled window.
4. Fall back to default routing when you do not need a specific tab.
