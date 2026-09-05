import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  rectangularSelection,
  dropCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { linter, lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import type { FormScriptDiagnostic } from 'core';
import { instrumentTheme, instrumentSyntaxHighlighting } from './instrumentTheme';

export interface CodeEditorHandle {
  focus(): void;
  /** Places the caret at a document offset - used after inserting an
   * autocomplete pick or a script snippet, mirroring the old
   * textarea.setSelectionRange(cursor, cursor) call it replaces. */
  setCursor(pos: number): void;
}

interface CodeEditorProps {
  value: string;
  onChange(value: string): void;
  diagnostics: FormScriptDiagnostic[];
  /** Fired after every doc/selection change with the live text and caret
   * offset, so the host can re-run its own id-autocomplete regex against
   * the text up to the caret - same job the old onClick/onKeyUp handlers
   * did by reading textarea.selectionStart. */
  onCursorActivity(value: string, pos: number): void;
  onSave(): void;
  onEscape(): void;
  ariaLabel: string;
}

/** Maps this app's own FormScriptDiagnostic[] (1-based line/column from the
 * TypeScript compiler) onto CodeMirror's lint state, which wants 0-based
 * document offsets. Diagnostics without a line (whole-script errors, see
 * diagnosticLocation()'s "Form Script" fallback) have nowhere sensible to
 * underline inline, so they're skipped here - the diagnostics list panel
 * below the editor still shows them in full. */
function toCmDiagnostics(state: EditorState, diagnostics: FormScriptDiagnostic[]): CmDiagnostic[] {
  const result: CmDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (!diagnostic.line || diagnostic.line < 1 || diagnostic.line > state.doc.lines) continue;
    const line = state.doc.line(diagnostic.line);
    const column = Math.max(1, diagnostic.column || 1);
    const from = Math.min(line.from + column - 1, line.to);
    const to = Math.min(from + Math.max(1, diagnostic.length || 1), line.to);
    result.push({
      from,
      to: to > from ? to : from,
      severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
      message: diagnostic.message,
    });
  }
  return result;
}

/**
 * Controlled CodeMirror 6 wrapper for form-script.ts editing - replaces a
 * plain <textarea> (no highlighting, no line numbers, no bracket matching)
 * with a real TypeScript-aware editor. Diagnostics are pushed in
 * imperatively via setDiagnostics() rather than CodeMirror's own async
 * linter() scheduling, since this app already runs its own debounced
 * TypeScript check (ScriptEditor.tsx's `check()`) and just needs somewhere
 * to display the result.
 */
const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  { value, onChange, diagnostics, onCursorActivity, onSave, onEscape, ariaLabel },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onCursorActivityRef = useRef(onCursorActivity);
  const onSaveRef = useRef(onSave);
  const onEscapeRef = useRef(onEscape);
  onChangeRef.current = onChange;
  onCursorActivityRef.current = onCursorActivity;
  onSaveRef.current = onSave;
  onEscapeRef.current = onEscape;

  useImperativeHandle(ref, () => ({
    focus() {
      viewRef.current?.focus();
    },
    setCursor(pos: number) {
      const view = viewRef.current;
      if (!view) return;
      const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
      view.dispatch({ selection: { anchor: clamped } });
    },
  }), []);

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      doc: value,
      parent: hostRef.current,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        indentUnit.of('  '),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        lintGutter(),
        linter(() => []),
        javascript({ typescript: true }),
        instrumentTheme,
        instrumentSyntaxHighlighting,
        EditorView.lineWrapping,
        keymap.of([
          { key: 'Mod-s', run: () => { onSaveRef.current(); return true; }, preventDefault: true },
          { key: 'Escape', run: () => { onEscapeRef.current(); return false; } },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          if (update.docChanged || update.selectionSet) {
            onCursorActivityRef.current(update.state.doc.toString(), update.state.selection.main.head);
          }
        }),
      ],
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Editor is constructed once; `value`/diagnostics are synced via the
    // effects below rather than by recreating the view on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep CodeMirror's document in sync when `value` changes from outside
  // (AI-candidate acceptance, autocomplete insertion, form reload) without
  // fighting the view over cursor position on every local keystroke.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state, diagnostics)));
  }, [diagnostics]);

  return <div ref={hostRef} className="script-code-editor" role="textbox" aria-label={ariaLabel} aria-multiline="true" />;
});

export default CodeEditor;
