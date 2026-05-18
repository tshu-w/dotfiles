# Patch Workflow

## Style-first patch loop

Use this order for layout or styling issues:

1. `dom.query` or `dom.describe`
2. `styles.get_computed`
3. `patch.apply_styles`
4. `layout.get_box_model`
5. optional `screenshot.capture_element`
6. `patch.rollback`

Prefer style patches for:

- overflow fixes
- spacing adjustments
- flex or grid tuning
- visibility toggles
- typography checks

## DOM patch loop

Use DOM patches for:

- text replacement
- setting or removing an attribute
- toggling a class

Keep DOM patches minimal and reversible.

## Verification

After any patch:

- compare box metrics when geometry matters
- compare computed styles when appearance matters
- capture a cropped screenshot only when the visual outcome is still unclear

## Cleanup

- Roll back every patch before finishing.
- If multiple patches are active, list them before rolling back so the subagent can explain what was tested.
