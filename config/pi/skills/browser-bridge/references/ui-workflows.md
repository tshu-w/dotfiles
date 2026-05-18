# UI Workflows

## Localhost HMR Verify Loop

Use when a dev server is already running and you want to prove a fix rendered.

1. `page.get_state`
2. `dom.query` on the target area with explicit tight limits such as `maxNodes: 5`, `maxDepth: 2`, and `textBudget: 300`
3. `styles.get_computed` or `layout.get_box_model`
4. `patch.apply_styles` to prove the visual fix
5. Edit source files
6. `dom.wait_for` on the component selector
7. `page.get_console`
8. `patch.rollback`

Acceptance:

- target element renders with expected layout or styles
- no new console errors after HMR
- temporary patch is rolled back

## Form + Network + Console Triage

Use when a submission flow fails silently or the UI state is inconsistent.

1. `dom.find_by_role` for the form control
2. `input.type` / `input.click`
3. `page.get_network`
4. `page.get_console`
5. `dom.wait_for` for success or error state
6. `dom.query` on the resulting panel or message

Acceptance:

- request status and failing endpoint are identified
- visible error or success state matches the network result
- console exceptions are ruled in or out

## Design QA / Patch Then Fix

Use when comparing the live UI to an expected layout or visual spec.

1. `dom.query` for the component subtree
2. `styles.get_computed` with a narrow property list
3. `layout.get_box_model`
4. `patch.apply_styles`
5. verify with `styles.get_computed` or `layout.get_box_model`
6. edit source
7. `patch.rollback`

Acceptance:

- the live patch proves the intended fix
- source implementation matches the validated patch
- no patch is left active

## Responsive Verification

Use when a component only breaks at a specific breakpoint.

1. `page.get_state`
2. `viewport.resize`
3. `dom.wait_for`
4. `layout.get_box_model`
5. `styles.get_computed`
6. `page.get_console`
7. `viewport.resize` with `reset: true`

Acceptance:

- the target breakpoint is reproduced
- geometry and style regressions are confirmed without a full screenshot
- viewport override is reset

## Hover / Tooltip / Drag Verification

Use when transient states matter.

Hover:

1. `dom.find_by_text` or `dom.find_by_role`
2. `input.hover`
3. `dom.query` for tooltip or menu
4. `styles.get_computed`

Drag:

1. `dom.query` for source and destination
2. `input.drag`
3. `dom.wait_for`
4. `dom.query` to verify order or placement

Acceptance:

- transient state appears while the interaction is active
- DOM and layout confirm the intended state change

## Accessibility Structure Verification

Use when semantic navigation matters more than CSS selectors.

1. `dom.find_by_role` for known controls
2. `dom.query` or `dom.describe` for focused verification
3. `dom.get_accessibility_tree` only if role discovery is insufficient

Acceptance:

- expected interactive roles are present
- accessible names match the UI copy
- the full accessibility tree is only used when lighter reads fail
