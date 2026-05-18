# Tailwind CSS - Agent Guide

> Load this reference when `page.get_state` returns `hints.tailwind: true`.

## Selector Escaping

Tailwind arbitrary-value classes use `[]` which are invalid in CSS selectors:

| Class in HTML         | ❌ Raw selector | ✅ Escaped selector         |
| --------------------- | --------------- | --------------------------- |
| `top-[30px]`          | `.top-[30px]`   | `.top-\[30px\]`             |
| `bg-[#f00]`           | `.bg-[#f00]`    | `.bg-\[\#f00\]`             |
| `w-[calc(100%-2rem)]` | crashes         | `.w-\[calc\(100\%-2rem\)\]` |

**Bridge auto-escapes** Tailwind brackets in `dom.query` selectors. But for `page.evaluate` or `dom.wait_for`, escape manually or avoid class-based selectors entirely.

## Preferred Approaches (Don't Select by Tailwind Class)

Tailwind class names are styling implementation details. Prefer semantic selectors:

1. **By text** - `dom.find_by_text('Submit')` - works regardless of styling
2. **By role** - `dom.find_by_role('button', 'Save')` - semantic, stable
3. **By data attribute** - `dom.query '[data-testid="header"]'` - CI-friendly
4. **By tag structure** - `dom.query 'nav > ul > li:first-child a'` - layout-based
5. **By ID** - `dom.query '#checkout-form'` - unique, fast

Only use Tailwind class selectors as a last resort when no semantic handle exists.

## Reading Tailwind Styles

Don't try to parse Tailwind classes to understand styles. Use bridge methods instead:

```bash
# ❌ Parsing classes: "flex items-center gap-4 p-6 bg-white rounded-lg shadow-md"
# ✅ Read the actual computed styles:
bbx styles el_abc 'display,align-items,gap,padding,background-color,border-radius,box-shadow'
```

Key patterns:

- **Layout**: `styles.get_computed` with `display, flex-direction, gap, grid-template-columns`
- **Spacing**: `layout.get_box_model` - gives padding/margin/border as numbers
- **Colors**: `styles.get_computed` with `background-color, color, border-color`
- **Visibility**: `styles.get_computed` with `display, visibility, opacity`

## Patching Tailwind Pages

Tailwind uses utility classes, but `patch.apply_styles` works at the inline-style level (higher specificity). Patches override Tailwind regardless:

```bash
# This overrides Tailwind's p-4 (padding: 1rem):
bbx patch-style el_abc 'padding=2rem'

# Override responsive breakpoints:
bbx patch-style el_abc display=grid grid-template-columns='1fr 1fr'
```

No need to understand or modify Tailwind classes - patch inline and it wins.

## Responsive Testing

Tailwind uses breakpoint prefixes (`sm:`, `md:`, `lg:`, `xl:`, `2xl:`). To test responsive behavior:

```bash
bbx resize 375 812      # mobile
bbx styles el_abc 'display,flex-direction,grid-template-columns'

bbx resize 768 1024     # tablet (md: breakpoint)
bbx styles el_abc 'display,flex-direction,grid-template-columns'

bbx resize 1280 800     # desktop (xl: breakpoint)
bbx styles el_abc 'display,flex-direction,grid-template-columns'
```

Default Tailwind breakpoints: `sm: 640px`, `md: 768px`, `lg: 1024px`, `xl: 1280px`, `2xl: 1536px`.

## Common Tailwind Anti-Patterns

| Anti-pattern                                     | Cost                            | Fix                                      |
| ------------------------------------------------ | ------------------------------- | ---------------------------------------- |
| Selecting by Tailwind class `.flex.items-center` | Fragile, breaks on refactor     | `dom.find_by_role` or `dom.find_by_text` |
| Parsing class string to infer styles             | ~500 tok wasted                 | `styles.get_computed` with property list |
| Patching by adding Tailwind classes              | Won't work (classes need build) | `patch.apply_styles` with CSS properties |
| Using `!important` in patches                    | Unnecessary                     | Inline styles already beat utilities     |
