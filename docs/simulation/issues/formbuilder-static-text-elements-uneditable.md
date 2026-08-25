Category: bug

## What I was trying to do

Hands-on UX audit of the FormBuilder designer's drag-and-drop layout
elements. Dragged "Header / Title" from the Layout Elements panel onto
a form's canvas, then tried to customize its displayed text (it defaults
to the placeholder "Section Header").

## What happened

Selecting the header shows a Field Config panel with a "Field Label"
input under LABEL & TEXT. Editing it only changes the small technical
badge above the card (`HEADER: <value>`) - the actual rendered heading
text on the canvas stays "Section Header" no matter what's typed there.
There is no other control in the panel for it: the panel also shows a
"CHOICES" (Options/Value table) section and an "AQL PREFILL (HIP)
MAPPING" section, both copied verbatim from the normal field-config
panel and meaningless for a static header (a header has no options and
nothing to prefill). Double-clicking the header text on the canvas does
nothing either - no inline edit mode.

Repeated the same test with "Paragraph / Text" (defaults to "Layout text
description...") - identical result: no way to edit the actual paragraph
content anywhere in the UI.

## What I expected

Some way to set the actual displayed text of a Header/Title or
Paragraph/Text block - that's the entire purpose of dragging one onto a
form. At minimum a "Text"/"Content" field in the config panel; the
CHOICES and AQL PREFILL sections shouldn't appear at all for
non-input layout elements.

## Workaround taken for now

None found - as far as I could tell through the UI, these two layout
elements are currently unusable for their stated purpose (adding
explanatory headers/text to a form). Not investigated at the code level
(this was a UI-only audit), so the underlying cause (missing field-
config-panel case for `type: 'header'`/`type: 'paragraph'` vs. a broken
onChange binding) isn't identified yet.

## Suggested fix path (not attempted)

Needs code-level investigation of the Field Config panel component
(whatever renders LABEL & TEXT/CHOICES/AQL PREFILL) to find where it
branches on element type, and add a proper text-content editor for
`header`/`paragraph` elements while suppressing the field-only sections
(Choices, AQL Prefill, Behavior) for them.
