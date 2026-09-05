import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * The "instrument panel" look for engineering surfaces (Script Editor, and
 * later AQL Functions / Composition-Script) - deliberately always dark,
 * independent of any app-wide theme toggle (this app has none). See
 * docs/design-audit (2026-09) for the two-mode rationale: clinical screens
 * stay a calm paper light mode, engineering screens read as an instrument
 * panel so the two are never visually confused with each other.
 *
 * Colors reference the --instrument-* custom properties in index.css, not
 * hardcoded hex, so the palette stays in one place as it's extended to
 * other engineering surfaces.
 */
export const instrumentTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--instrument-ink)',
      backgroundColor: 'var(--instrument-bg)',
      height: '100%',
      fontSize: '0.86rem',
    },
    '.cm-content': {
      caretColor: 'var(--instrument-teal)',
      fontFamily: 'var(--mono)',
      padding: '0.9rem 0',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--instrument-teal)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'rgba(111, 200, 189, 0.22)',
    },
    '.cm-panels': { backgroundColor: 'var(--instrument-bg-raised)', color: 'var(--instrument-ink)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--instrument-rule)' },
    '.cm-searchMatch': { backgroundColor: 'rgba(224, 171, 85, 0.25)', outline: '1px solid var(--instrument-amber)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(224, 171, 85, 0.4)' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.035)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255, 255, 255, 0.035)', color: 'var(--instrument-ink-soft)' },
    '.cm-gutters': {
      backgroundColor: 'var(--instrument-bg)',
      color: 'var(--instrument-ink-faint)',
      border: 'none',
      fontFamily: 'var(--mono)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.9rem 0 0.3rem' },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--instrument-bg-raised)',
      border: '1px solid var(--instrument-rule)',
      color: 'var(--instrument-ink-soft)',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: 'rgba(111, 200, 189, 0.18)',
      outline: '1px solid var(--instrument-teal)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--instrument-bg-raised)',
      border: '1px solid var(--instrument-rule)',
      color: 'var(--instrument-ink)',
      fontFamily: 'var(--sans)',
      fontSize: '0.8rem',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'rgba(111, 200, 189, 0.16)',
      color: 'var(--instrument-teal)',
    },
    '.cm-diagnostic': { fontFamily: 'var(--sans)' },
    '.cm-diagnostic-error': { borderLeftColor: 'var(--instrument-brick)' },
    '.cm-diagnostic-warning': { borderLeftColor: 'var(--instrument-amber)' },
    '.cm-lintPoint-error::after': { borderBottomColor: 'var(--instrument-brick)' },
    '.cm-lintPoint-warning::after': { borderBottomColor: 'var(--instrument-amber)' },
    '.cm-lintRange-error': { textDecoration: 'underline wavy var(--instrument-brick)', textUnderlineOffset: '3px' },
    '.cm-lintRange-warning': { textDecoration: 'underline wavy var(--instrument-amber)', textUnderlineOffset: '3px' },
  },
  { dark: true },
);

/** Token colors - deliberately restrained: violet for language keywords,
 * teal for calls (echoes the accent used for "valid/compiled" state
 * elsewhere in the instrument UI), amber for literals, everything else
 * stays a quiet off-white so the highlighted tokens actually stand out. */
export const instrumentHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--instrument-violet)' },
  { tag: [t.controlKeyword, t.operatorKeyword, t.modifier], color: 'var(--instrument-violet)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--instrument-teal)' },
  { tag: t.string, color: 'var(--instrument-amber)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--instrument-amber)' },
  { tag: [t.comment, t.blockComment, t.lineComment], color: 'var(--instrument-ink-faint)', fontStyle: 'italic' },
  { tag: t.propertyName, color: '#d4c9a8' },
  { tag: t.typeName, color: 'var(--instrument-teal)' },
  { tag: t.className, color: 'var(--instrument-teal)' },
  { tag: [t.punctuation, t.bracket], color: 'var(--instrument-ink-soft)' },
  { tag: t.operator, color: 'var(--instrument-ink-soft)' },
  { tag: t.invalid, color: 'var(--instrument-brick)', textDecoration: 'underline wavy' },
]);

export const instrumentSyntaxHighlighting = syntaxHighlighting(instrumentHighlightStyle);
