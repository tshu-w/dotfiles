---
name: pi-extension-development
description: Development and review guidelines for Pi extensions (plugins) and custom tools. Use for registerTool definitions, model-facing descriptions and prompts, results/details, errors, truncation, pagination, renderCall, or cross-extension code reuse.
---

# Pi Extension Development Guidelines

## General

1. Read the docs and examples for the current Pi version, and use built-in tools as references for implementation style, including their `description` and `promptSnippet`.

2. Keep extensions isolated: never import local helpers across extensions. Reuse public package APIs, or keep the implementation local to each extension.

3. Limit `description`, `promptSnippet`, and `promptGuidelines` to what the model needs to call the tool correctly, and update them whenever parameters, defaults, or behavior change.

## Results and Errors

4. Return successful results as natural text. Put authoritative state, structured results, and programmatic metadata in `details`. Do not mirror raw arguments or the full rendered text merely for convenience; repeat values when they are part of the authoritative result or required by programmatic consumers. If the result text is truncated, `details` must still retain the complete authoritative state.

5. Throw tool errors for invalid parameters, invalid state, cancellation, and execution failures; valid empty results, such as no matches, stay successful. Long loops, such as cross-file scans, must check for cancellation on each iteration.

6. Make error messages actionable: list candidates for an ambiguous prefix and include the existing ID for a naming conflict.

7. When the result requires a follow-up call or step, provide a concise Next Action the model can follow directly; otherwise omit it. For pagination, use `[N more results. Use offset=X to continue.]` only when another page exists.

## Truncation

8. Bound result content with Pi's exported limits and truncation functions instead of hard-coded values. Append notices after applying the limits. Keep error messages bounded at their source instead of generically rewrapping errors.

9. Use Pi's native truncation format. The `truncation` fields must describe the retained content, including whether its last line is partial.

10. Pass through bounded upstream results with their content and `details` unchanged. For unbounded upstream results, truncate when the content exceeds the limits, update `truncation`, and preserve any existing `fullOutputPath`.

11. Save complete output to a temporary file when it is too large. When stable pagination can recover everything omitted, provide a continuation offset instead of a temporary file.

12. After complete output is saved, report `fullOutputPath` in both the text and `details`; never report a path that was not written. If saving fails, fail the tool when the result is cheap to rerun; when rerunning is expensive or unsafe, return the truncated result with a bounded notice. When bounding error output, preserve the original error semantics and do not let a save failure replace the original error. Do not add fallbacks for cases that cannot occur.

## Pagination

13. Define pagination semantics in the parameter descriptions. For lists and searches, `offset` may be a zero-based skip count; line readers may use one-based line numbers. Keep the default, positive minimum, and validation or normalization of `limit` consistent across the schema, description, and implementation so each continuation can advance.

14. Define out-of-range behavior: lists and searches return a successful empty page with the total count; line readers return an error.

## Tool Call Rendering

15. Render calls as `tool(key=value, ...)`: serialize values with `JSON.stringify`, omit `undefined` arguments, and add a newline once the result is ready. Bold only the tool name and leave everything else in the normal text color, not muted gray.

16. Show argument values in full by default. Shorten a value only when the result text immediately repeats the same content in full.
