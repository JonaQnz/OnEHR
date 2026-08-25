Category: bug

## What I was trying to do

Hands-on UX audit of the FormBuilder designer (drag-and-drop a new form
from `vg_Procedure.v1.1.0`, check every field-config affordance). Opened
a field's config panel and toggled "Hidden by default" under BEHAVIOR,
expecting it to hide the field the way `alwaysHidden` (just shipped -
see the `alwaysHidden` feature commit) does.

## What happened

The toggle visibly sets `hidden: true` on the vendored
react-form-builder2 element (confirmed via the panel's own "JSON" tab -
`Canonical Field JSON` showed `"hidden": true` on the raw builder
element). But the actual saved/published form never gets a `hidden`
property on that field's layout node at all - checked via the "Live
JSON" tab (the real canonical `FormElementLayout`), which lists `id,
name, type, unit, label, binding, helpText, readOnly, required,
uiElement, validation, description, placeholder, semanticType,
showTimeSelect, archetypeNodeId, showTimeSelectOnly` and nothing else.
No `hidden`, no `alwaysHidden`.

Root cause (matches an earlier code-level finding from this session):
`apps/web/src/adapters/formBuilderAdapter.ts`, which converts a
react-form-builder2 element into the canonical `FormElementLayout`,
never reads `element.hidden` at all - it's silently dropped during
conversion. The vendored library's own edit UI
(`packages/react-form-builder2/src/form-elements-edit.jsx:417-420`)
renders the checkbox, but nothing downstream consumes its value.

## What I expected

Toggling "Hidden by default" to actually hide the field in the
published form - i.e. to set `alwaysHidden: true` on the canonical
layout node, the same mechanism `Patientenaufnahme`'s `Namensart` field
now uses (see the `alwaysHidden` feature).

## Workaround taken for now

None - not touched during this audit, purely observed and documented.
`alwaysHidden` can still be set by hand-editing a form's `canonical_json`
via `update_form` (as done for `Namensart`), so the capability isn't
missing platform-wide - only this specific UI control for it is broken.

## Suggested fix path (not attempted)

`apps/web/src/adapters/formBuilderAdapter.ts`: when converting a
react-form-builder2 element to a `FormElementLayout`, map
`element.hidden === true` to `alwaysHidden: true` (and the reverse
when loading a canonical form back into the builder, so the checkbox
reflects the real saved state on re-open). This reuses existing UI -
no new control needed, just wiring the existing checkbox to the
existing `alwaysHidden` field.
