import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChangeEvent, CSSProperties, FormEvent, ReactNode } from 'react';
import type {
  CanonicalForm,
  FormDefinitionV1,
  FormElementLayout,
  FormScriptChangeSource,
  FormScriptEventName,
  RuntimeFieldDescriptor,
  RuntimeValues,
  RuntimeValidationIssue,
  FormSessionRuntimeContext,
  CodeMappingValue,
  CodeMappingTerminologyOption,
  TerminologyConcept,
  TerminologyValidationOutcome,
} from 'core';
import * as CoreRuntime from 'core';
import { isBlockingIssue } from 'core';
import { API_BASE_URL } from '../integration/apiBaseUrl';
import { ExtensionSlot, ExtensionWrapperSlot, useFrontendPlugins } from './FrontendPluginRegistry';
import { ClinicalGrid } from './layout/ClinicalLayout';
import {
  FormScriptClient,
  type FormScriptFieldMessage,
  type FormScriptFieldProvenance,
  type FormScriptLifecycleResult,
  type FormScriptPrefillConflict,
  type FormScriptUiState,
} from '../scripting/runtime/FormScriptClient';
import { PrefillConflictDialog, type PrefillConflictItem } from './PrefillConflictDialog';

type RuntimeDefinition = CanonicalForm | FormDefinitionV1;
type GroupRow = Record<string, unknown>;

interface GroupContext {
  groupId: string;
  index: number;
  row: GroupRow;
  disabled: boolean;
}

export interface RuntimeRendererProps {
  field: RuntimeFieldDescriptor;
  node: FormElementLayout;
  value: unknown;
  /** The first blocking (isBlockingIssue - see packages/core/form-runtime)
   * issue for this field, kept for backward compatibility with renderers
   * written before multi-issue/severity support - prefer `issues` (all
   * issues, own severity each) in new renderers. */
  error?: RuntimeValidationIssue;
  /** Every issue currently attached to this field - errors and warnings
   * alike, in the order form-runtime/form-script produced them. */
  issues?: RuntimeValidationIssue[];
  disabled: boolean;
  onChange: (value: unknown) => void;
}

export type RuntimeRenderer = (props: RuntimeRendererProps) => ReactNode;

export interface FormRuntimeProps {
  definition: RuntimeDefinition;
  initialValues?: RuntimeValues;
  readOnly?: boolean;
  busy?: boolean;
  showSubmit?: boolean;
  submitLabel?: string;
  patientId?: string;
  ehrId?: string;
  encounterId?: string;
  sessionId?: string;
  /** Trusted host override. Required fields are deliberately never hidden. */
  hiddenFieldIds?: string[];
  /** Trusted host override: per-field display-label override, keyed by
   * field id. Cosmetic only - never changes validation, options, or any
   * other field behavior, and never touches the Form Section's own
   * canonical label (a Composition block's per-instance rename). */
  fieldLabelOverrides?: Record<string, string>;
  /** Server-loaded data such as the last Flat Composition; never merged into form values. */
  runtimeContext?: FormSessionRuntimeContext;
  rendererOverrides?: Record<string, RuntimeRenderer>;
  onValuesChange?: (values: RuntimeValues) => void;
  mode?: 'create' | 'edit' | 'view' | 'preview' | 'prefill';
  onSubmit?: (values: RuntimeValues) => void | Promise<void>;
  /** Shows this Form Section's own name/version as an `<h1>` above its
   * fields. Default true (a standalone runtime page has nothing else to
   * announce the form). A host that already shows its own title for this
   * form - a Composition block's card header, e.g. - should pass false to
   * avoid a second, redundant heading right above the first. */
  showHeader?: boolean;
  /** Drops the outer white bordered card this component normally draws
   * around itself. Default false. A host that already provides its own
   * bordered container - again, a Composition block's card - should pass
   * true, so an embedded Form Section doesn't end up boxed a second time
   * inside a box it's already inside. */
  chromeless?: boolean;
  /** Shows every field's validation issues immediately, bypassing the
   * normal touched/blurred gating (see the `touchedFields`-based visibility
   * rule below). Intended for FormBuilder's own Preview tab, where the
   * designer is deliberately testing rules and gating would only get in
   * the way. Default false/undefined - a real clinician-facing form keeps
   * the gating so a freshly opened form isn't immediately loud with
   * warnings on empty fields. */
  alwaysShowValidation?: boolean;
}

export interface FormRuntimeHandle {
  runLifecycle(name: FormScriptEventName): Promise<FormScriptLifecycleResult>;
  applyValues(values: RuntimeValues, source?: FormScriptChangeSource, emitChanges?: boolean): void;
  getValues(): RuntimeValues;
}

function idOf(node: FormElementLayout): string | undefined {
  return node.id || node.name;
}

/** Flattens a repeatable container's own children down to its actual LEAF
 * fields, descending through any 'row'/'column'/plain-container structural
 * wrapper (see NON_FIELD_LAYOUT_TYPES) - used for a 'table' displayMode
 * group's own column set (P0.2 audit, 2026-09-05). A real archetype-driven
 * layout always nests a field at least one row/column deep (container >
 * row > column > field), so without this flattening step, table mode would
 * never find any columns at all on a real form. Does NOT descend into a
 * nested repeatable container - one table cell rendering another whole
 * repeatable group makes no sense, and nested repeats aren't even
 * supported yet (see [[p02-repeatables-audit-and-first-fixes]]). */
function collectTableColumns(node: FormElementLayout): FormElementLayout[] {
  const columns: FormElementLayout[] = [];
  const walk = (current: FormElementLayout) => {
    if (current !== node && current.type === 'container' && current.repeatable === true) return;
    if (!CoreRuntime.NON_FIELD_LAYOUT_TYPES.has(current.type)) { columns.push(current); return; }
    current.children?.forEach(walk);
  };
  node.children?.forEach(walk);
  return columns;
}

function inputType(node: FormElementLayout): string {
  if (node.type === 'input-date-time') return 'datetime-local';
  if (node.type === 'input-time') return 'time';
  if (node.type === 'input-date') return 'date';
  // input-proportion has its own dedicated branch below (a {numerator,
  // denominator?} object, never a bare number) - never reaches this
  // generic fallback, so it's deliberately not included here.
  if (node.type === 'input-number') return 'number';
  return 'text';
}

function isEmpty(value: unknown): boolean {
  return value === undefined
    || value === null
    || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function rowsOf(value: unknown): GroupRow[] {
  return Array.isArray(value)
    ? value.filter((item): item is GroupRow => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function fieldIdFromIssuePath(path: string): string {
  const finalSegment = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1) : path;
  return finalSegment.replace(/\[\d+\].*$/, '');
}

function inputStyle(invalid: boolean, disabled: boolean): CSSProperties {
  return {
    width: '100%',
    padding: '0.55rem 0.7rem',
    border: `1px solid ${invalid ? '#dc2626' : '#cbd5e1'}`,
    borderRadius: '6px',
    background: disabled ? '#f8fafc' : 'white',
  };
}

// Above this many options, "CodedWithOther" switches its coded half from
// radio buttons to a <select> (matching deriveDefaultWidget's own 4-option
// radio/select threshold for a plain coded field) - a handful of real
// vg_Diagnosis.v1.1.1 fields (severity, diagnostic_certainty, ...) all stay
// well under this, but the component still needs to hold up for a larger
// coded-or-free-text field elsewhere.
const CODED_WITH_OTHER_RADIO_THRESHOLD = 6;
const OTHER_SENTINEL = '__allow_free_text_other__';

/**
 * "DV_CODED_TEXT + DV_TEXT → Coded Choice + 'Other / free text'"
 * (OPT constraint engine architecture, section 19) - the live widget for
 * `node.uiElement === 'CodedWithOther'`. Only ever offered on a field with
 * `field.allowFreeText` (set at import time from the constraint model, see
 * webTemplateParser.ts) - a value outside `field.options` is a deliberate,
 * valid free-text entry, both to validateRuntimeValues and to the
 * serializer (setFlatValue/buildLeafDvValue fall back to plain DV_TEXT for
 * exactly this case), not a bug in this widget.
 *
 * A hooks-owning function component (not a plain helper called inline from
 * `fieldInput`) is required here - React's rules of hooks forbid calling
 * useState/useEffect from a conditionally-invoked plain function.
 */
function CodedWithOtherInput({
  field, value, disabled, invalid, inputName, onChange,
}: {
  field: RuntimeFieldDescriptor;
  value: unknown;
  disabled: boolean;
  invalid: boolean;
  inputName: string;
  onChange: (next: unknown) => void;
}) {
  const matchesOption = typeof value === 'string' && field.options.some((option) => option.value === value);
  const hasFreeTextValue = typeof value === 'string' && value !== '' && !matchesOption;
  const [otherMode, setOtherMode] = useState(hasFreeTextValue);
  // A value change from outside this widget (form reset, edit-mode load,
  // FormScript setValue) that turns out to be free text must still flip the
  // widget into "Anderer Wert" mode - otherwise a real stored free-text
  // value would render as nothing selected at all.
  useEffect(() => {
    if (hasFreeTextValue) setOtherMode(true);
  }, [hasFreeTextValue]);

  const selectOther = () => { setOtherMode(true); onChange(''); };
  const selectOption = (optionValue: string) => { setOtherMode(false); onChange(optionValue); };
  const style = inputStyle(invalid, disabled);

  const codedControl = field.options.length > CODED_WITH_OTHER_RADIO_THRESHOLD ? (
    <select
      style={style}
      disabled={disabled}
      value={otherMode ? OTHER_SENTINEL : (typeof value === 'string' ? value : '')}
      onChange={(event) => (event.target.value === OTHER_SENTINEL ? selectOther() : selectOption(event.target.value))}
    >
      <option value="">Bitte auswählen</option>
      {field.options.map((option) => <option key={option.value} value={option.value}>{option.text}</option>)}
      <option value={OTHER_SENTINEL}>Anderer Wert …</option>
    </select>
  ) : (
    <div style={{ display: 'grid', gap: '0.4rem' }}>
      {field.options.map((option) => (
        <label key={option.value} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input type="radio" name={inputName} disabled={disabled} checked={!otherMode && value === option.value} onChange={() => selectOption(option.value)} />
          {option.text}
        </label>
      ))}
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <input type="radio" name={inputName} disabled={disabled} checked={otherMode} onChange={selectOther} />
        Anderer Wert …
      </label>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {codedControl}
      {otherMode && (
        <input
          style={style}
          type="text"
          disabled={disabled}
          value={typeof value === 'string' && !matchesOption ? value : ''}
          placeholder="Freitext eingeben …"
          onChange={(event) => onChange(event.target.value)}
          autoFocus
        />
      )}
    </div>
  );
}

// Above this many options, an "autocomplete"-suggested field (see
// deriveDefaultWidget) with no enumerable option list at all can't actually
// search against anything - it degrades to a plain text input rather than a
// permanently-empty, broken search box. This is the one case the section 19
// rule table calls "large/external terminology" without this app having any
// live terminology-search backend for a *native* DV_CODED_TEXT field wired
// up yet (unlike the separate, designer-configured codeMappings feature) -
// see docs/features/opt-constraint-engine-analysis.md.
function AutocompleteInput({
  field, value, disabled, invalid, onChange,
}: {
  field: RuntimeFieldDescriptor;
  value: unknown;
  disabled: boolean;
  invalid: boolean;
  onChange: (next: unknown) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const style = inputStyle(invalid, disabled);

  useEffect(() => {
    function onOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutsideClick);
    return () => document.removeEventListener('mousedown', onOutsideClick);
  }, []);

  if (field.options.length === 0) {
    return <input style={style} type="text" autoComplete="off" disabled={disabled} value={String(value ?? '')} placeholder="Freitext eingeben …" onChange={(event) => onChange(event.target.value)} />;
  }

  const selectedOption = field.options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? field.options.filter((option) => option.text.toLowerCase().includes(normalizedQuery) || option.value.toLowerCase().includes(normalizedQuery)).slice(0, 50)
    : field.options.slice(0, 50);

  const commit = (optionValue: string) => { onChange(optionValue); setOpen(false); setQuery(''); };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        style={style}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        disabled={disabled}
        value={open ? query : (selectedOption?.text ?? '')}
        placeholder="Suchen …"
        onFocus={() => { setOpen(true); setQuery(''); setHighlighted(0); }}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setHighlighted(0); }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setHighlighted((current) => Math.min(current + 1, filtered.length - 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted((current) => Math.max(current - 1, 0)); }
          else if (event.key === 'Enter') { event.preventDefault(); const match = filtered[highlighted]; if (match) commit(match.value); }
          else if (event.key === 'Escape') setOpen(false);
        }}
      />
      {!open && selectedOption && !disabled && (
        <button
          type="button"
          aria-label="Auswahl löschen"
          onClick={() => onChange(undefined)}
          style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', border: 0, background: 'transparent', color: '#64748b', cursor: 'pointer' }}
        >
          ×
        </button>
      )}
      {open && (
        <ul
          role="listbox"
          style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, margin: '0.25rem 0 0', padding: '0.25rem', listStyle: 'none', background: 'white', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '14rem', overflowY: 'auto', boxShadow: '0 4px 12px rgba(15, 23, 42, 0.12)' }}
        >
          {filtered.length === 0 && <li style={{ padding: '0.4rem 0.6rem', color: '#64748b', fontSize: '0.85rem' }}>Keine Treffer</li>}
          {filtered.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={index === highlighted}
              onMouseDown={(event) => { event.preventDefault(); commit(option.value); }}
              onMouseEnter={() => setHighlighted(index)}
              style={{ padding: '0.4rem 0.6rem', borderRadius: '4px', cursor: 'pointer', background: index === highlighted ? '#eef2ff' : 'transparent' }}
            >
              {option.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Fetch helpers for the generic, provider-agnostic `/api/terminology/*`
 * routes (apps/api/src/routes/terminologyRoutes.ts) - this component never
 * knows or cares which backend (HAPI or otherwise) actually answers. See
 * TerminologyBindingEditor (FormBuilder.tsx) for the Designer-side sibling
 * that configures `terminology.providerId`/`bindingId`/etc. in the first
 * place. */
async function fetchTerminologySearch(terminology: CodeMappingTerminologyOption, query: string, signal: AbortSignal): Promise<TerminologyConcept[]> {
  const params = new URLSearchParams({ provider: terminology.providerId || '', query });
  if (terminology.bindingId) params.set('bindingId', terminology.bindingId);
  if (terminology.bindingVersion) params.set('bindingVersion', terminology.bindingVersion);
  if (terminology.namespace) params.set('namespace', terminology.namespace);
  if (terminology.namespaceVersion) params.set('namespaceVersion', terminology.namespaceVersion);
  params.set('limit', '20');
  const response = await fetch(`${API_BASE_URL}/terminology/search?${params.toString()}`, { signal });
  if (!response.ok) throw new Error(`search failed (${response.status})`);
  return response.json();
}

async function fetchTerminologyValidate(terminology: CodeMappingTerminologyOption, code: string): Promise<TerminologyValidationOutcome> {
  const params = new URLSearchParams({ provider: terminology.providerId || '', code });
  if (terminology.bindingId) params.set('bindingId', terminology.bindingId);
  if (terminology.bindingVersion) params.set('bindingVersion', terminology.bindingVersion);
  if (terminology.namespace) params.set('namespace', terminology.namespace);
  if (terminology.namespaceVersion) params.set('namespaceVersion', terminology.namespaceVersion);
  try {
    const response = await fetch(`${API_BASE_URL}/terminology/validate?${params.toString()}`);
    // A non-2xx here (network error already thrown below; this covers HTTP-
    // level failures like an unregistered/uninstalled provider, 404'd by
    // terminologyRoutes.ts) is deliberately folded into 'unreachable', not
    // silently ignored - see [[Section D: no silent free-text fallback]] in
    // the terminology plan: a configured-but-currently-unavailable provider
    // must still surface as "can't verify right now", never as if no
    // provider had ever been configured at all.
    if (!response.ok) return { status: 'unreachable', message: `HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { status: 'unreachable', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Turns a resolved `TerminologyValidationOutcome` into a field issue per
 * the mapping's `validationPolicy` (packages/core/terminology's
 * TerminologyValidationPolicy doc comment has the full three-level
 * semantics) - `null` means "no issue, clear whatever was there before".
 * `policy==='none'` never even reaches this (no validate() call is made at
 * all - see TerminologyCodeInput's blur handler). */
function issueForValidationOutcome(outcome: TerminologyValidationOutcome, policy: 'required' | 'best-effort' | 'none'): { message: string; severity: 'error' | 'warning' } | null {
  if (outcome.status === 'valid') return null;
  if (outcome.status === 'unreachable' || outcome.status === 'provider-error') {
    const message = 'Terminologie-Server aktuell nicht erreichbar - Code konnte nicht geprüft werden.';
    return policy === 'best-effort' ? { message, severity: 'warning' } : { message, severity: 'error' };
  }
  const reason = outcome.status === 'unknown-namespace' ? 'Terminologie unbekannt'
    : outcome.status === 'unknown-binding' ? 'Auswahlliste unbekannt'
    : outcome.status === 'unknown-version' ? 'Version unbekannt'
    : 'Code nicht gefunden';
  return { message: `Ungültiger Code (${reason}).`, severity: 'error' };
}

/**
 * The `mapping.code` input for a `codeMappings` terminology entry once it
 * carries a `providerId` (search-while-typing against a real terminology
 * server) - see AutocompleteInput just above for the sibling that filters
 * static, already-loaded `field.options` instead; this one calls out to
 * `/api/terminology/search` live. A `providerId`-less terminology option
 * keeps the plain, unvalidated text `<input>` (see the codeMappings render
 * branch in `fieldInput` below) exactly as before this feature existed.
 */
function TerminologyCodeInput({
  terminology, mapping, disabled, onChange, onValidation,
}: {
  terminology: CodeMappingTerminologyOption;
  mapping: CodeMappingValue;
  disabled: boolean;
  onChange: (next: CodeMappingValue) => void;
  onValidation: (issue: { message: string; severity: 'error' | 'warning' } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<TerminologyConcept[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    function onOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutsideClick);
    return () => { document.removeEventListener('mousedown', onOutsideClick); abortRef.current?.abort(); clearTimeout(debounceRef.current); };
  }, []);

  const runSearch = (query: string) => {
    abortRef.current?.abort();
    if (query.trim().length < 2) { setResults([]); setLoading(false); setSearchError(null); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setSearchError(null);
    fetchTerminologySearch(terminology, query, controller.signal)
      .then((concepts) => { if (!controller.signal.aborted) { setResults(concepts); setLoading(false); } })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setResults([]);
        setSearchError(error instanceof Error ? error.message : String(error));
      });
  };

  const scheduleSearch = (query: string) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(query), 300);
  };

  const commitConcept = (concept: TerminologyConcept) => {
    onChange({ terminologyId: terminology.id, code: concept.code, version: concept.namespaceVersion, display: concept.display, ...(terminology.match ? { match: terminology.match } : {}) });
    onValidation(null); // a search hit is already known-good - no separate validate() round-trip needed.
    setOpen(false);
    setResults([]);
  };

  const runValidateOnBlur = () => {
    setOpen(false);
    const policy = terminology.validationPolicy || 'required';
    if (policy === 'none' || !mapping.code.trim()) { onValidation(null); return; }
    void fetchTerminologyValidate(terminology, mapping.code).then((outcome) => onValidation(issueForValidationOutcome(outcome, policy)));
  };

  const style = inputStyle(false, disabled);
  return (
    // minWidth: 0 - found live (2026-09-04): without it, a flex item's
    // default min-width:auto keeps it at its content's intrinsic width, so
    // this combobox (and the dropdown results list positioned relative to
    // it) never shrinks to fit the row - it and the trailing "Zuordnung
    // entfernen" button after it get pushed past the visible card edge,
    // making the remove button unreachable. Classic flexbox overflow
    // gotcha, not specific to this component's own width.
    <div ref={containerRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <input
        style={{ ...style, padding: '0.4rem 0.6rem' }}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        value={mapping.code}
        placeholder="Code suchen oder eingeben …"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          const code = event.target.value;
          onChange({ ...mapping, code, version: undefined, display: undefined });
          onValidation(null);
          setOpen(true);
          setHighlighted(0);
          scheduleSearch(code);
        }}
        onBlur={runValidateOnBlur}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setHighlighted((current) => Math.min(current + 1, results.length - 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlighted((current) => Math.max(current - 1, 0)); }
          else if (event.key === 'Enter') { const match = results[highlighted]; if (match) { event.preventDefault(); commitConcept(match); } }
          else if (event.key === 'Escape') setOpen(false);
        }}
      />
      {mapping.display && <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.15rem' }}>{mapping.display}{mapping.version ? ` · v${mapping.version}` : ''}</div>}
      {open && (
        <ul
          role="listbox"
          style={{ position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, margin: '0.25rem 0 0', padding: '0.25rem', listStyle: 'none', background: 'white', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '14rem', overflowY: 'auto', boxShadow: '0 4px 12px rgba(15, 23, 42, 0.12)' }}
        >
          {loading && <li style={{ padding: '0.4rem 0.6rem', color: '#64748b', fontSize: '0.85rem' }}>Suche …</li>}
          {!loading && searchError && <li style={{ padding: '0.4rem 0.6rem', color: '#b91c1c', fontSize: '0.85rem' }}>Terminologie-Suche fehlgeschlagen: {searchError}</li>}
          {!loading && !searchError && mapping.code.trim().length >= 2 && results.length === 0 && <li style={{ padding: '0.4rem 0.6rem', color: '#64748b', fontSize: '0.85rem' }}>Keine Treffer</li>}
          {!loading && !searchError && results.map((concept, index) => (
            <li
              key={`${concept.code}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              onMouseDown={(event) => { event.preventDefault(); commitConcept(concept); }}
              onMouseEnter={() => setHighlighted(index)}
              style={{ padding: '0.4rem 0.6rem', borderRadius: '4px', cursor: 'pointer', background: index === highlighted ? '#eef2ff' : 'transparent' }}
            >
              <div style={{ fontWeight: 600 }}>{concept.code}</div>
              {concept.display && <div style={{ fontSize: '0.8rem', color: '#64748b' }}>{concept.display}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const FormRuntime = forwardRef<FormRuntimeHandle, FormRuntimeProps>(function FormRuntime({
  definition,
  initialValues,
  readOnly = false,
  busy = false,
  showSubmit = true,
  submitLabel = 'Formular absenden',
  patientId,
  ehrId,
  encounterId,
  sessionId,
  hiddenFieldIds = [],
  fieldLabelOverrides = {},
  runtimeContext,
  rendererOverrides = {},
  onValuesChange,
  onSubmit,
  mode = 'preview',
  showHeader = true,
  chromeless = false,
  alwaysShowValidation = false,
}, ref) {
  const { renderers } = useFrontendPlugins();
  const effectiveRendererOverrides = useMemo(() => ({
    ...renderers,
    ...rendererOverrides
  }), [renderers, rendererOverrides]);

  const fields = useMemo(() => CoreRuntime.collectRuntimeFields(definition), [definition]);
  const groups = useMemo(() => CoreRuntime.collectRuntimeGroups(definition), [definition]);
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const fieldById = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const groupFields = useMemo(() => {
    const result: Record<string, string[]> = {};
    fields.forEach((field) => {
      if (!field.repeatableGroupId) return;
      result[field.repeatableGroupId] = [...(result[field.repeatableGroupId] || []), field.id];
    });
    return result;
  }, [fields]);
  const initialRuntimeValues = useMemo(
    () => ({ ...CoreRuntime.createInitialRuntimeValues(definition), ...initialValues }),
    [definition, initialValues],
  );
  const [values, setValues] = useState<RuntimeValues>(initialRuntimeValues);
  const [submitted, setSubmitted] = useState(false);
  const [uiStates, setUiStates] = useState<Record<string, FormScriptUiState>>({});
  const [scriptErrors, setScriptErrors] = useState<Record<string, FormScriptFieldMessage>>({});
  // Async, server-side terminology-validate() results for codeMappings
  // entries - keyed the same way scriptErrors is (a synthetic path per
  // mapping, since a mapping is a value *within* a field's value, not a
  // field of its own) and merged into `issues` the same way, `source:
  // 'server'` (see the Terminologie-Server-Integration plan's section C/D
  // and TerminologyCodeInput just above).
  const [terminologyIssues, setTerminologyIssues] = useState<Record<string, { message: string; severity: 'error' | 'warning' }>>({});
  const [toast, setToast] = useState<{ level: string; message: string } | null>(null);
  // Field-path -> how far the clinician has interacted with it, for the
  // validation-message visibility rule (see visibleIssues below): a
  // warning/info shows as soon as the field is 'changed'; a blocking error
  // waits for 'blurred' (or the existing `submitted` trigger). Bypassed
  // entirely when alwaysShowValidation is set (FormBuilder's Preview tab).
  const [touchedFields, setTouchedFields] = useState<Record<string, 'changed' | 'blurred'>>({});
  const markChanged = (path: string) => setTouchedFields((prev) => (prev[path] ? prev : { ...prev, [path]: 'changed' }));
  const markBlurred = (path: string) => setTouchedFields((prev) => (prev[path] === 'blurred' ? prev : { ...prev, [path]: 'blurred' }));
  // Which of the currently-set field values came from field(id).prefill(...)
  // rather than a clinician's own entry - drives the small provenance
  // badge next to a field. Keyed by field id; a field with no entry here
  // (or explicitly null) was set some other way. See
  // docs/features/aql-prefill.md.
  const [fieldProvenance, setFieldProvenance] = useState<Record<string, FormScriptFieldProvenance | null>>({});
  // Prefill attempts currently awaiting a clinician's decision (see
  // PrefillConflictDialog) - the Form Script's own field(id).prefill(...)
  // call is suspended until resolvePrefillConflicts() answers every one
  // of these by requestId.
  const [pendingPrefillConflicts, setPendingPrefillConflicts] = useState<PrefillConflictItem[]>([]);
  const valuesRef = useRef(values);
  const nonPersistedIdsRef = useRef(new Set<string>());
  // Stable per-row React keys for repeatable groups (P0.2 audit, 2026-09-05).
  // Rows themselves carry no identity beyond array position (neither
  // openEHR's own repeating-structural-node RM shape nor this app's
  // `values[groupId] = GroupRow[]` convention has one, and adding a real
  // `_id` field onto GroupRow would need stripping everywhere it's ever
  // serialized or exposed to Form Scripts). Keying each rendered row by
  // `${groupId}-${index}` (the previous approach) meant removing/reordering
  // any row but the last one reassigns every following row's React key to a
  // DIFFERENT row's data - React then reuses that DOM subtree's internal
  // state (any uncontrolled input's cursor position, an expanded/collapsed
  // accordion, in-flight terminology-search dropdown state, ...) for what
  // is now a different clinical entry. Purely a rendering-identity concern,
  // never touches `values` or goes anywhere near serialization - a parallel
  // array of generated keys, index-aligned with the CURRENT rows array and
  // kept in sync by every mutation (add/remove/duplicate/reorder) below.
  const rowKeysRef = useRef<Record<string, string[]>>({});
  const newRowKey = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substr(2, 12));
  /** Lazily grows/shrinks a group's key array to match `count`, generating
   * a fresh key for any brand-new index (initial load/prefill/edit-mode
   * reload never goes through addRow/duplicateRow, so this is the only
   * place a group's very first key set gets created). Never shrinks by
   * removing from the middle itself - callers that remove/reorder a
   * specific row splice/move this array explicitly, in lockstep with the
   * matching `rows` mutation, before this ever gets a chance to just
   * truncate the tail. */
  const rowKeysFor = (groupId: string, count: number): string[] => {
    const current = rowKeysRef.current[groupId] || [];
    if (current.length === count) return current;
    const next = current.slice(0, count);
    while (next.length < count) next.push(newRowKey());
    rowKeysRef.current[groupId] = next;
    return next;
  };
  /** Splices out the key at `index` - must run before the next render's
   * `rowKeysFor` call for a row removal, or that call's own naive
   * length-mismatch handling (truncate the tail) would drop the wrong
   * row's key instead of the removed one's. */
  const removeRowKey = (groupId: string, index: number) => {
    const current = rowKeysRef.current[groupId] || [];
    rowKeysRef.current[groupId] = current.filter((_key, i) => i !== index);
  };
  /** Inserts a fresh key right after `index` - for a duplicated row landing
   * immediately below its source. */
  const insertRowKeyAfter = (groupId: string, index: number) => {
    const current = rowKeysRef.current[groupId] || [];
    const next = current.slice();
    next.splice(index + 1, 0, newRowKey());
    rowKeysRef.current[groupId] = next;
  };
  /** Swaps the keys at two indices - keeps each row's identity attached to
   * its own data when reordering, rather than a row's key silently
   * following its old array slot. */
  const swapRowKeys = (groupId: string, indexA: number, indexB: number) => {
    const current = (rowKeysRef.current[groupId] || []).slice();
    [current[indexA], current[indexB]] = [current[indexB], current[indexA]];
    rowKeysRef.current[groupId] = current;
  };
  const scriptClientRef = useRef<FormScriptClient | null>(null);
  const formScript = 'formScript' in definition ? definition.formScript : undefined;
  const scriptIds = useMemo(() => CoreRuntime.collectFormScriptSchemaIds(definition), [definition]);
  const requiredFieldIds = useMemo(
    () => fields.filter((field) => field.required).map((field) => field.id),
    [fields],
  );
  const scriptRuntimeContext = useMemo(() => ({
    ...(runtimeContext?.composition ? { composition: runtimeContext.composition } : {}),
    aql: runtimeContext?.aql || {},
  }), [runtimeContext]);

  const persistentValues = (): RuntimeValues => Object.fromEntries(
    Object.entries(valuesRef.current).filter(([id]) => !nonPersistedIdsRef.current.has(id)),
  ) as RuntimeValues;

  useEffect(() => {
    valuesRef.current = values;
  }, [values]);

  useEffect(() => {
    nonPersistedIdsRef.current.clear();
    setValues(initialRuntimeValues);
    valuesRef.current = initialRuntimeValues;
    scriptClientRef.current?.syncValues(initialRuntimeValues, 'load', true);
    setSubmitted(false);
    setScriptErrors({});
  }, [initialRuntimeValues]);

  useEffect(() => {
    onValuesChange?.(Object.fromEntries(
      Object.entries(values).filter(([id]) => !nonPersistedIdsRef.current.has(id)),
    ) as RuntimeValues);
  }, [onValuesChange, values]);

  useEffect(() => {
    if (!formScript?.compiled.trim()) return;
    setUiStates({});
    setScriptErrors({});
    const client = new FormScriptClient({
      formId: definition.id,
      compiled: formScript.compiled,
      values: valuesRef.current,
      ids: scriptIds,
      groupFields,
      requiredFields: requiredFieldIds,
      context: {
        formId: definition.id,
        formVersion: definition.version,
        templateId: definition.sourceTemplates?.[0]?.id,
        patientId,
        ehrId,
        encounterId,
        sessionId,
        locale: definition.settings?.defaultLocale || 'de-DE',
        mode,
        user: { roles: [] },
        ...scriptRuntimeContext,
      },
      runtimeFunctions: runtimeContext?.codeFunctions || [],
      onSetValue: (id, value, persist, provenance) => {
        if (persist) nonPersistedIdsRef.current.delete(id);
        else nonPersistedIdsRef.current.add(id);
        setValues((previous) => {
          const next = { ...previous, [id]: value as never };
          valuesRef.current = next;
          return next;
        });
        setFieldProvenance((previous) => (previous[id] === provenance ? previous : { ...previous, [id]: provenance }));
      },
      onUpdateValues: (nextValues, persist) => {
        Object.keys(nextValues).forEach((id) => {
          if (persist) nonPersistedIdsRef.current.delete(id);
          else nonPersistedIdsRef.current.add(id);
        });
        setValues((previous) => {
          const next = { ...previous, ...nextValues };
          valuesRef.current = next;
          return next;
        });
      },
      onValidationErrors: setScriptErrors,
      onUiState: (kind, id, state) => {
        const key = `${kind}:${id}`;
        setUiStates((previous) => ({
          ...previous,
          [key]: { ...previous[key], ...state },
        }));
      },
      onToast: (level, message) => setToast({ level, message }),
      onPrefillConflict: (conflict: FormScriptPrefillConflict) => {
        setPendingPrefillConflicts((previous) => [...previous, {
          requestId: conflict.requestId,
          fieldId: conflict.fieldId,
          fieldLabel: fieldById.get(conflict.fieldId)?.label,
          currentValue: conflict.currentValue,
          prefillValue: conflict.prefillValue,
        }]);
      },
    });
    scriptClientRef.current = client;
    void client.ready()
      .then(async () => {
        const before = await client.runLifecycle('beforeLoad', valuesRef.current);
        if (!before.cancelled) await client.runLifecycle('afterLoad', valuesRef.current);
      })
      .catch((error: Error) => {
        // AbortError means this client was torn down (cleanup below) before
        // ready/beforeLoad/afterLoad finished - most commonly React
        // StrictMode's dev-mode mount/cleanup/mount replay, or a fast
        // real unmount. That's expected teardown, not a script failure, so
        // there's nothing to tell the user about.
        if (error?.name === 'AbortError') return;
        setToast({ level: 'error', message: error.message });
      });

    return () => {
      if (scriptClientRef.current === client) scriptClientRef.current = null;
      // Any conflict this client raised is now unanswerable (its worker is
      // gone) - drop it rather than leave a dialog open referencing a dead
      // requestId.
      setPendingPrefillConflicts([]);
      void client.destroy(valuesRef.current);
    };
  }, [
    definition.id,
    definition.settings?.defaultLocale,
    definition.sourceTemplates,
    definition.version,
    encounterId,
    ehrId,
    formScript?.compiled,
    groupFields,
    mode,
    patientId,
    sessionId,
    requiredFieldIds,
    scriptIds,
    scriptRuntimeContext,
  ]);

  const resolvePrefillConflicts = (resolutions: Array<{ requestId: string; apply: boolean }>) => {
    resolutions.forEach(({ requestId, apply }) => scriptClientRef.current?.resolvePrefillConflict(requestId, apply));
    const resolvedIds = new Set(resolutions.map((item) => item.requestId));
    setPendingPrefillConflicts((previous) => previous.filter((item) => !resolvedIds.has(item.requestId)));
  };

  useImperativeHandle(ref, () => ({
    runLifecycle: async (name) => (
      scriptClientRef.current?.runLifecycle(name, valuesRef.current) || { cancelled: false }
    ),
    applyValues: (nextValues, source = 'load', emitChanges = true) => {
      Object.keys(nextValues).forEach((id) => nonPersistedIdsRef.current.delete(id));
      setValues((previous) => {
        const next = { ...previous, ...nextValues };
        valuesRef.current = next;
        return next;
      });
      scriptClientRef.current?.syncValues(nextValues, source, emitChanges);
    },
    getValues: persistentValues,
  }), []);

  const validation = useMemo(() => {
    const base = CoreRuntime.validateRuntimeValues(definition, values);
    const issues = base.issues.filter((issue) => {
      const fieldId = fieldIdFromIssuePath(issue.path);
      const dynamic = uiStates[`fields:${fieldId}`];
      if (dynamic?.visible === false) return false;
      if (issue.code === 'required' && dynamic?.required === false) return false;
      if (issue.code === 'option' && dynamic?.options) return false;
      return true;
    });

    fields.forEach((field) => {
      const dynamic = uiStates[`fields:${field.id}`];
      const checkValue = (value: unknown, path: string) => {
        if (
          dynamic?.required === true
          && dynamic.visible !== false
          && isEmpty(value)
          && !issues.some((issue) => issue.path === path && issue.code === 'required')
        ) {
          issues.push({
            path,
            code: 'required',
            message: `${dynamic.label || field.label} is required.`,
          });
        }
        if (dynamic?.options && !isEmpty(value)) {
          const selected = Array.isArray(value) ? value : [value];
          if (selected.some((item) => (
            typeof item !== 'string'
            || !dynamic.options?.some((option) => option.value === item)
          ))) {
            issues.push({
              path,
              code: 'option',
              message: `${dynamic.label || field.label} contains an unsupported option.`,
            });
          }
        }
      };

      if (field.repeatableGroupId) {
        rowsOf(values[field.repeatableGroupId]).forEach((row, index) => {
          checkValue(row[field.id], `${field.repeatableGroupId}[${index}].${field.id}`);
        });
      } else {
        checkValue(values[field.id], field.id);
      }
    });

    Object.entries(scriptErrors).forEach(([path, entry]) => {
      // code: 'script' (not the generic 'type') so a Form Script business
      // rule is distinguishable from an RM-type/shape problem wherever
      // issues are inspected later (Live-JSON debug view, backend logs).
      issues.push({ path, code: 'script', message: entry.message, severity: entry.severity, source: entry.source });
    });
    Object.entries(terminologyIssues).forEach(([path, entry]) => {
      issues.push({ path, code: 'mapping-invalid', message: entry.message, severity: entry.severity, source: 'server' });
    });
    // Mirrors CoreRuntime.validateRuntimeValues's own `valid` computation
    // (form-runtime/index.ts) - only isBlockingIssue(...) issues block.
    // `issues.length === 0` here would have made a form with nothing but
    // warnings (e.g. a DV_QUANTITY precision warning, or a script
    // validate() returning severity: 'warning') incorrectly unsubmittable.
    const valid = !issues.some(isBlockingIssue);
    return { valid, issues };
  }, [definition, fields, scriptErrors, terminologyIssues, uiStates, values]);

  const update = (id: string, value: unknown) => {
    nonPersistedIdsRef.current.delete(id);
    setValues((previous) => {
      const previousValue = previous[id];
      if (Object.is(previousValue, value)) return previous;
      const next = { ...previous, [id]: value as never };
      valuesRef.current = next;
      scriptClientRef.current?.dispatchChange(id, value, previousValue, 'user');
      return next;
    });
  };

  const updateGroupField = (
    groupId: string,
    index: number,
    fieldId: string,
    value: unknown,
  ) => {
    nonPersistedIdsRef.current.delete(groupId);
    setValues((previous) => {
      const rows = rowsOf(previous[groupId]);
      const row = rows[index];
      if (!row) return previous;
      const previousValue = row[fieldId];
      if (Object.is(previousValue, value)) return previous;
      const nextRows = rows.map((item, itemIndex) => (
        itemIndex === index ? { ...item, [fieldId]: value } : item
      ));
      const next = { ...previous, [groupId]: nextRows as never };
      valuesRef.current = next;
      scriptClientRef.current?.dispatchGroupChange(
        groupId,
        index,
        fieldId,
        value,
        previousValue,
        'user',
      );
      return next;
    });
  };

  const replaceGroupRows = (
    groupId: string,
    nextRows: GroupRow[],
    action?: { type: 'add'; index: number; item: GroupRow } | { type: 'remove'; index: number; item: GroupRow },
  ) => {
    nonPersistedIdsRef.current.delete(groupId);
    setValues((previous) => {
      const next = { ...previous, [groupId]: nextRows as never };
      valuesRef.current = next;
      if (action?.type === 'add') scriptClientRef.current?.addGroupItem(groupId, action.index, action.item);
      if (action?.type === 'remove') scriptClientRef.current?.removeGroupItem(groupId, action.index, action.item);
      if (!action) scriptClientRef.current?.syncValues({ [groupId]: nextRows as never }, 'user', false);
      return next;
    });
  };

  const issuesFor = (id: string, groupContext?: GroupContext) => {
    const path = groupContext ? `${groupContext.groupId}[${groupContext.index}].${id}` : id;
    return validation.issues.filter((issue) => issue.path === path || issue.path.startsWith(`${path}[`));
  };

  const fieldInput = (
    field: RuntimeFieldDescriptor,
    node: FormElementLayout,
    value: unknown,
    onChange: (next: unknown) => void,
    issues?: RuntimeValidationIssue[],
    inputName = field.id,
    // The exact issue-path convention issuesFor/visibleIssues filter by
    // (see renderField's basePath/`${basePath}[${index}]`) - only actually
    // needed by the codeMappings branch below, to key its async
    // terminology-validate() issues so they land on the right field.
    issuePath = field.id,
  ): ReactNode => {
    const dynamic = uiStates[`fields:${field.id}`];
    const disabled = readOnly || dynamic?.enabled === false || dynamic?.readonly === true || field.readOnly;
    // A missing severity has always meant "blocking" (see isBlockingIssue,
    // packages/core/form-runtime) - kept identical here so a plain error
    // (no severity set) still counts.
    const error = issues?.find(isBlockingIssue);
    const override = effectiveRendererOverrides[field.type] || effectiveRendererOverrides[node.uiElement || ''];
    if (override) return override({ field, node, value, error, issues, disabled, onChange });
    const invalid = Boolean(error);
    const style = {
      width: '100%',
      padding: '0.55rem 0.7rem',
      border: `1px solid ${invalid ? '#dc2626' : '#cbd5e1'}`,
      borderRadius: '6px',
      background: disabled ? '#f8fafc' : 'white',
    };
    const eventValue = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const nextValue = event.target.type === 'number' && event.target.value !== ''
        ? Number(event.target.value)
        : event.target.value;
      onChange(nextValue);
    };

    if (node.uiElement === 'Checkboxes' && field.options.length > 0) {
      const selected = Array.isArray(value) ? value : [];
      return <div style={{ display: 'grid', gap: '0.4rem' }}>{field.options.map((option) => <label key={option.value} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><input type="checkbox" disabled={disabled} checked={selected.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />{option.text}</label>)}</div>;
    }
    if (node.uiElement === 'RadioButtons' && field.options.length > 0) {
      return <div style={{ display: 'grid', gap: '0.4rem' }}>{field.options.map((option) => <label key={option.value} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><input type="radio" name={inputName} disabled={disabled} checked={value === option.value} onChange={() => onChange(option.value)} />{option.text}</label>)}</div>;
    }
    // "DV_CODED_TEXT + DV_TEXT -> Coded Choice + 'Other / free text'"
    // (architecture doc section 19) - only meaningful, and only ever set as
    // a default, on a field the constraint model flagged allowFreeText, but
    // rendered here regardless of that flag (a designer can pick this
    // uiElement by hand too) since the widget itself degrades gracefully -
    // see CodedWithOtherInput.
    if (node.uiElement === 'CodedWithOther') {
      return <CodedWithOtherInput field={field} value={value} disabled={disabled} invalid={invalid} inputName={inputName} onChange={onChange} />;
    }
    // "DV_CODED_TEXT + große/externe Terminologie -> Search / Autocomplete"
    // - see AutocompleteInput for the no-enumerable-options degradation.
    if (node.uiElement === 'Autocomplete') {
      return <AutocompleteInput field={field} value={value} disabled={disabled} invalid={invalid} onChange={onChange} />;
    }
    if (node.uiElement === 'TextArea') return <textarea style={{ ...style, minHeight: '7rem', resize: 'vertical' }} autoComplete="off" disabled={disabled} value={String(value ?? '')} placeholder={node.placeholder || ''} onChange={eventValue} />;
    if (node.uiElement === 'Dropdown' || node.type === 'input-select' || node.type === 'input-ordinal') {
      const selectedValue = Array.isArray(value) ? value.map(String) : String(value ?? '');
      return <select style={style} disabled={disabled} multiple={Array.isArray(value)} value={selectedValue} onChange={(event) => onChange(event.target.multiple ? Array.from(event.target.selectedOptions, (option) => option.value) : event.target.value)}><option value="">Bitte auswählen</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.text}</option>)}</select>;
    }
    if (node.type === 'input-boolean' || node.uiElement === 'Checkbox') return <label style={{ display: 'flex', gap: '0.55rem', alignItems: 'center' }}><input type="checkbox" disabled={disabled} checked={value === true} onChange={(event) => onChange(event.target.checked)} />Ja</label>;
    if (node.type === 'input-quantity') {
      const quantity = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      return <div style={{ display: 'flex', gap: '0.5rem' }}><input style={{ ...style, flex: 1 }} type="number" disabled={disabled} value={String(quantity.magnitude ?? '')} onChange={(event) => onChange({ ...quantity, magnitude: event.target.value === '' ? null : Number(event.target.value) })} />{field.unitOptions.length > 0 ? <select style={{ ...style, maxWidth: '10rem' }} disabled={disabled} value={String(quantity.unit || '')} onChange={(event) => onChange({ ...quantity, unit: event.target.value })}><option value="">Einheit</option>{field.unitOptions.map((option) => <option key={option.unit} value={option.unit}>{option.unit}</option>)}</select> : null}</div>;
    }
    if (node.type === 'input-proportion') {
      // DV_PROPORTION runtime value: {numerator, denominator?} - mirrors
      // input-quantity's {magnitude, unit} shape just above. Widget UX
      // decision (2026-09-02): for the common 'percent'/'unitary' kinds the
      // denominator is fixed by the archetype (100 / 1) and never shown -
      // one plain number field, exactly like input-number. Every other
      // kind ('ratio'/'fraction'/'integer_fraction', or no proportionType
      // at all, i.e. genuinely unconstrained) shows numerator AND
      // denominator side by side, since both vary. The denominator itself
      // is filled in server-side (setFlatValue/buildLeafDvValue) when
      // implied, not by this widget - so the single-field case's onChange
      // only ever touches `numerator`.
      const proportion = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const impliedDenominator = field.proportionType === 'unitary' || field.proportionType === 'percent';
      if (impliedDenominator) {
        return (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input style={{ ...style, flex: 1 }} type="number" disabled={disabled} value={String(proportion.numerator ?? '')} onChange={(event) => onChange(event.target.value === '' ? null : { numerator: Number(event.target.value) })} />
            {field.proportionType === 'percent' ? <span style={{ color: '#64748b', fontSize: '0.85rem' }}>%</span> : null}
          </div>
        );
      }
      return (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input style={{ ...style, flex: 1 }} type="number" disabled={disabled} placeholder="Zähler" value={String(proportion.numerator ?? '')} onChange={(event) => onChange({ ...proportion, numerator: event.target.value === '' ? null : Number(event.target.value) })} />
          <span style={{ color: '#94a3b8' }}>/</span>
          <input style={{ ...style, flex: 1 }} type="number" disabled={disabled} placeholder="Nenner" value={String(proportion.denominator ?? '')} onChange={(event) => onChange({ ...proportion, denominator: event.target.value === '' ? null : Number(event.target.value) })} />
        </div>
      );
    }
    if (node.type === 'input-interval') {
      // DV_INTERVAL<DV_QUANTITY> runtime value: {lower?: {magnitude, unit},
      // upper?: {magnitude, unit}} - two input-quantity-shaped bounds
      // sharing one unit picker (real archetype ranges - a dose range, an
      // administration-duration range - always bound the same physical
      // quantity on both ends; per-bound units are still stored correctly
      // if a script/import ever sets them differently, this control just
      // never needs to offer that). Was a total gap before this - see
      // canonicalComposition.ts's DV_INTERVAL<DV_QUANTITY> branch for the
      // full writeup (P0.1 audit, 2026-09-05).
      const interval = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const lower = interval.lower && typeof interval.lower === 'object' ? interval.lower as Record<string, unknown> : {};
      const upper = interval.upper && typeof interval.upper === 'object' ? interval.upper as Record<string, unknown> : {};
      const unit = String(lower.unit || upper.unit || '');
      const setBound = (bound: 'lower' | 'upper', patch: Record<string, unknown>) => {
        const current = bound === 'lower' ? lower : upper;
        onChange({ ...interval, [bound]: { ...current, ...patch } });
      };
      return (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input style={{ ...style, flex: 1 }} type="number" placeholder="von" disabled={disabled} value={String(lower.magnitude ?? '')} onChange={(event) => setBound('lower', { magnitude: event.target.value === '' ? null : Number(event.target.value), unit: lower.unit ?? unit })} />
          <span style={{ color: '#94a3b8' }}>–</span>
          <input style={{ ...style, flex: 1 }} type="number" placeholder="bis" disabled={disabled} value={String(upper.magnitude ?? '')} onChange={(event) => setBound('upper', { magnitude: event.target.value === '' ? null : Number(event.target.value), unit: upper.unit ?? unit })} />
          {field.unitOptions.length > 0 ? (
            <select
              style={{ ...style, maxWidth: '10rem' }}
              disabled={disabled}
              value={unit}
              // Always writes the unit to both bounds, even one still empty
              // of a magnitude (mirrors input-quantity's own unconditional
              // {...quantity, unit} above) - a bound picking up a unit with
              // no magnitude yet is what makes "select the unit first, then
              // type both numbers" work; that half-filled state is a normal
              // mid-entry moment, not itself invalid (validateIntervalBound
              // only flags a bound that HAS a magnitude with no matching
              // unit, or vice versa with content already present).
              onChange={(event) => onChange({ lower: { ...lower, unit: event.target.value }, upper: { ...upper, unit: event.target.value } })}
            >
              <option value="">Einheit</option>
              {field.unitOptions.map((option) => <option key={option.unit} value={option.unit}>{option.unit}</option>)}
            </select>
          ) : null}
        </div>
      );
    }
    if (node.type === 'input-identifier') {
      // DV_IDENTIFIER runtime value: {id, issuer?, assigner?, type?} - id is
      // the only RM-mandatory attribute (1..1, "not id.is_empty"), the rest
      // are each 0..1 free text. A reloaded id-only value comes back as a
      // bare string, not `{id: ...}` (see openehr-engine's readFlatValue -
      // this same rmType is also used, unchanged, by a pre-existing plain
      // input-text field elsewhere, so the wire format only grows an object
      // shape once issuer/assigner/type actually have content), so both
      // shapes are normalized here on read. Was a total Designer gap before
      // this (P0.1 audit, 2026-09-05) - a DV_IDENTIFIER field could only
      // ever be entered as bare free text, with no way to supply issuer/
      // assigner/type even though the write/read pipeline already fully
      // supported them.
      const identifier = typeof value === 'string' ? { id: value } : (value && typeof value === 'object' ? value as Record<string, unknown> : {});
      const setPart = (part: 'id' | 'issuer' | 'assigner' | 'type', partValue: string) => {
        const next = { ...identifier, [part]: partValue === '' ? undefined : partValue };
        onChange(next);
      };
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <input style={style} type="text" placeholder="ID" disabled={disabled} value={String(identifier.id ?? '')} onChange={(event) => setPart('id', event.target.value)} />
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input style={{ ...style, flex: 1 }} type="text" placeholder="Aussteller (issuer)" disabled={disabled} value={String(identifier.issuer ?? '')} onChange={(event) => setPart('issuer', event.target.value)} />
            <input style={{ ...style, flex: 1 }} type="text" placeholder="Vergebende Stelle (assigner)" disabled={disabled} value={String(identifier.assigner ?? '')} onChange={(event) => setPart('assigner', event.target.value)} />
            <input style={{ ...style, flex: 1 }} type="text" placeholder="Typ" disabled={disabled} value={String(identifier.type ?? '')} onChange={(event) => setPart('type', event.target.value)} />
          </div>
        </div>
      );
    }
    if (node.uiElement === 'Range' || node.type === 'input-range') return <input style={style} type="range" disabled={disabled} min={node.min_value ?? field.validation?.min ?? 0} max={node.max_value ?? field.validation?.max ?? 100} step={node.step ?? 1} value={Number(value ?? node.min_value ?? 0)} onChange={(event) => onChange(Number(event.target.value))} />;
    if (field.codeMappings?.enabled) {
      // {value, mappings?} (core.CodeMappedTextValue) instead of a plain
      // string - the text field itself is untouched, mappings render as
      // extra rows below it. Terminology is always designer-configured
      // (field.codeMappings.terminologies) - the clinician only ever
      // types/edits the code itself, per "Katalog hidden": no visible
      // terminology browser, just a code entry per configured terminology.
      const compound = (value && typeof value === 'object' && !Array.isArray(value)) ? value as { value?: unknown; mappings?: CodeMappingValue[] } : { value };
      const text = compound.value;
      const mappings = Array.isArray(compound.mappings) ? compound.mappings : [];
      const terminologies = field.codeMappings.terminologies;
      const commitMappings = (next: typeof mappings) => onChange({ value: text, ...(next.length > 0 ? { mappings: next } : {}) });
      const canAddMore = terminologies.length > 0 && (field.codeMappings.allowMultiple !== false || mappings.length === 0);
      const setMappingIssue = (rowKey: string, issue: { message: string; severity: 'error' | 'warning' } | null) => {
        setTerminologyIssues((current) => {
          if (!issue) { if (!(rowKey in current)) return current; const { [rowKey]: _removed, ...rest } = current; return rest; }
          return { ...current, [rowKey]: issue };
        });
      };
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <input style={style} type={inputType(node)} autoComplete="off" disabled={disabled} value={String(text ?? '')} placeholder={node.placeholder || ''} onChange={(event) => onChange({ value: event.target.value, ...(mappings.length > 0 ? { mappings } : {}) })} />
          {mappings.map((mapping, index) => {
            const terminology = terminologies.find((candidate) => candidate.id === mapping.terminologyId);
            return (
              <div key={index} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', paddingLeft: '0.6rem', borderLeft: '2px solid #e2e8f0' }}>
                {terminologies.length > 1 ? (
                  <select disabled={disabled} value={mapping.terminologyId} onChange={(event) => commitMappings(mappings.map((item, i) => i === index ? { terminologyId: event.target.value, code: item.code, match: terminologies.find((candidate) => candidate.id === event.target.value)?.match } : item))} style={{ ...style, width: 'auto', flexShrink: 0, padding: '0.4rem 0.5rem' }}>
                    {terminologies.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
                  </select>
                ) : (
                  <span style={{ fontSize: '0.78rem', color: '#64748b', flexShrink: 0, minWidth: '6rem' }}>{terminology?.label || mapping.terminologyId}</span>
                )}
                {terminology?.providerId ? (
                  <TerminologyCodeInput
                    terminology={terminology}
                    mapping={mapping}
                    disabled={disabled}
                    onChange={(next) => commitMappings(mappings.map((item, i) => i === index ? next : item))}
                    onValidation={(issue) => setMappingIssue(`${issuePath}[${index}]`, issue)}
                  />
                ) : (
                  <input style={{ ...style, flex: 1, padding: '0.4rem 0.6rem' }} type="text" autoComplete="off" disabled={disabled} value={mapping.code} placeholder="Code" onChange={(event) => commitMappings(mappings.map((item, i) => i === index ? { ...item, code: event.target.value } : item))} />
                )}
                <button type="button" disabled={disabled} title="Zuordnung entfernen" onClick={() => { setMappingIssue(`${issuePath}[${index}]`, null); commitMappings(mappings.filter((_item, i) => i !== index)); }} style={{ border: 0, background: 'transparent', color: '#64748b', cursor: 'pointer', padding: '0.3rem' }}>×</button>
              </div>
            );
          })}
          {!disabled && canAddMore && (
            <button type="button" onClick={() => commitMappings([...mappings, { terminologyId: terminologies[0].id, code: '', ...(terminologies[0].match ? { match: terminologies[0].match } : {}) }])} style={{ alignSelf: 'flex-start', border: '1px dashed #94a3b8', background: 'transparent', borderRadius: '6px', padding: '0.3rem 0.7rem', color: '#475569', cursor: 'pointer', fontSize: '0.78rem' }}>
              + Code hinzufügen
            </button>
          )}
        </div>
      );
    }
    return <input style={style} type={inputType(node)} autoComplete="off" disabled={disabled} value={String(value ?? '')} placeholder={node.placeholder || ''} onChange={eventValue} />;
  };

  // `compact`: table display mode's own cell rendering (P0.2 audit,
  // 2026-09-05) - the label/help-text block is dropped (the column header
  // already carries the label) and the whole field gets a tight wrapper
  // instead of the card layout's `marginBottom: '1.15rem'` block. Every
  // other behavior (repeatable sub-fields, issues, provenance) is
  // unchanged - a table cell is still a full field, just without its own
  // heading.
  const renderField = (node: FormElementLayout, groupContext?: GroupContext, compact = false): ReactNode => {
    const id = idOf(node);
    if (!id) return null;
    const field = fieldById.get(id);
    const dynamic = uiStates[`fields:${id}`];
    if (!field || field.alwaysHidden || (!field.required && hiddenFieldIds.includes(id)) || !CoreRuntime.isRuntimeFieldVisible(field, values) || dynamic?.visible === false) return null;
    const effectiveField: RuntimeFieldDescriptor = {
      ...field,
      label: dynamic?.label || fieldLabelOverrides[id] || field.label,
      description: dynamic?.helpText || field.description,
      required: dynamic?.required ?? field.required,
      readOnly: groupContext?.disabled || dynamic?.readonly || field.readOnly,
      options: dynamic?.options?.map((option) => ({ value: option.value, text: option.label })) || field.options,
    };
    const effectiveNode = { ...node, placeholder: dynamic?.placeholder || node.placeholder };
    const nodeIssues = issuesFor(id, groupContext);
    const fieldValue = groupContext ? groupContext.row[id] : values[id];
    const basePath = groupContext ? `${groupContext.groupId}[${groupContext.index}].${id}` : id;
    const commit = (next: unknown) => {
      if (groupContext) updateGroupField(groupContext.groupId, groupContext.index, id, next);
      else update(id, next);
    };

    const renderSingle = (value: unknown, index?: number) => {
      const issuesForValue = index === undefined
        ? nodeIssues
        : nodeIssues.filter((issue) => issue.path === `${basePath}[${index}]`);
      const key = index === undefined ? basePath : `${basePath}-${index}`;
      return (
        <div key={key} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
          <div
            style={{ flex: 1 }}
            onFocus={() => scriptClientRef.current?.uiEvent(id, 'focus')}
            onBlur={() => { scriptClientRef.current?.uiEvent(id, 'blur'); markBlurred(basePath); }}
          >
            {fieldInput(effectiveField, effectiveNode, value, (next) => {
              markChanged(basePath);
              if (index === undefined) {
                commit(next);
                return;
              }
              const list = Array.isArray(fieldValue) ? [...fieldValue] : [];
              list[index] = next;
              commit(list);
            }, issuesForValue, groupContext ? `${id}-${groupContext.index}` : id, index === undefined ? basePath : `${basePath}[${index}]`)}
          </div>
          {index !== undefined && <button type="button" disabled={readOnly || groupContext?.disabled} onClick={() => commit((Array.isArray(fieldValue) ? fieldValue : []).filter((_item, itemIndex) => itemIndex !== index))} style={{ border: 0, background: 'transparent', color: '#64748b', cursor: 'pointer', padding: '0.5rem' }}>×</button>}
        </div>
      );
    };

    // Visibility gating: alwaysShowValidation (FormBuilder's Preview tab)
    // bypasses this entirely - the designer is deliberately testing rules.
    // Otherwise: a non-blocking warning/info shows as soon as the field is
    // touched (changed is enough, no blur needed) so a designer-authored
    // hint appears while the clinician is still typing; a blocking error
    // waits for blur (finished editing this field) or the first submit
    // attempt, so a freshly-opened form isn't immediately loud with
    // "required" on every empty field.
    const touchState = touchedFields[basePath];
    const visibleIssues = alwaysShowValidation
      ? nodeIssues
      : nodeIssues.filter((issue) => (isBlockingIssue(issue) ? touchState === 'blurred' || submitted : touchState !== undefined));
    const issueTone = (issue: RuntimeValidationIssue) => (
      isBlockingIssue(issue)
        ? { color: '#b91c1c', background: '#fee2e2', border: '#fecaca' }
        : { color: '#b45309', background: '#fef3c7', border: '#fde68a' }
    );

    const repeated = field.repeatable ? (Array.isArray(fieldValue) ? fieldValue : []) : [];
    const displayValues = field.repeatable && repeated.length === 0 && field.repeatMin > 0
      ? Array.from({ length: field.repeatMin }, () => undefined)
      : repeated;

    const thisFieldProvenance = groupContext ? undefined : fieldProvenance[id];
    const body = (
      <>
        {effectiveField.repeatable ? <>{displayValues.map((item, index) => renderSingle(item, index))}<button type="button" disabled={readOnly || groupContext?.disabled || (effectiveField.repeatMax !== -1 && repeated.length >= effectiveField.repeatMax)} onClick={() => commit([...repeated, undefined])} style={{ border: '1px dashed #94a3b8', background: 'transparent', borderRadius: '6px', padding: '0.45rem 0.75rem', color: '#475569', cursor: 'pointer' }}>+ {effectiveField.label}</button></> : renderSingle(fieldValue)}
        {visibleIssues.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.35rem' }}>
            {visibleIssues.map((issue, index) => {
              const tone = issueTone(issue);
              return (
                <div
                  key={`${issue.path}-${issue.code}-${index}`}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: '0.35rem',
                    fontSize: '0.8rem', color: tone.color, background: tone.background,
                    border: `1px solid ${tone.border}`, borderRadius: '5px', padding: '0.3rem 0.55rem',
                  }}
                >
                  <span aria-hidden="true">{isBlockingIssue(issue) ? '⨯' : '⚠'}</span>
                  <span>{issue.message}</span>
                </div>
              );
            })}
          </div>
        )}
      </>
    );
    if (compact) return <div key={basePath}>{body}</div>;
    return (
      <div key={basePath} style={{ marginBottom: '1.15rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
          <label style={{ fontWeight: 600, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>
              {effectiveField.label}
              {effectiveField.required && <span style={{ color: '#dc2626' }}> *</span>}
            </span>
            {thisFieldProvenance && (
              <span
                title={thisFieldProvenance.timestamp ? `Aus AQL geladen: ${new Date(thisFieldProvenance.timestamp).toLocaleString('de-DE')}` : 'Aus AQL geladen'}
                style={{ fontSize: '0.72rem', fontWeight: 500, color: '#2563eb', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '999px', padding: '0.05rem 0.55rem' }}
              >
                ⤓ {thisFieldProvenance.source}{thisFieldProvenance.timestamp ? ` · ${new Date(thisFieldProvenance.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : ''}
              </span>
            )}
          </label>
          <ExtensionSlot name="form:field:actions" context={{ fieldId: id, groupId: groupContext?.groupId, rowIndex: groupContext?.index, readOnly }} />
        </div>
        {effectiveField.description && <div style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '0.4rem' }}>{effectiveField.description}</div>}
        {body}
      </div>
    );
  };

  const renderNode = (node: FormElementLayout, key: string, groupContext?: GroupContext): ReactNode => {
    const id = idOf(node);
    if ((node.type === 'button' || node.uiElement === 'Button') && id) {
      const dynamic = uiStates[`buttons:${id}`];
      if (dynamic?.visible === false) return null;
      return <button key={key} type="button" className="btn" disabled={readOnly || busy || groupContext?.disabled || dynamic?.enabled === false || dynamic?.loading === true} onClick={() => scriptClientRef.current?.clickButton(id)}>{dynamic?.loading ? 'Wird ausgeführt…' : dynamic?.label || node.label || node.content || id}</button>;
    }
    if (node.type === 'header') return <h2 key={key}>{node.content}</h2>;
    if (node.type === 'paragraph' || node.type === 'text') return <p key={key} style={{ color: '#475569' }}>{node.content}</p>;
    if (node.type === 'line-break') return <hr key={key} />;
    if (node.type === 'row') return <ClinicalGrid key={key} columns={Math.min(3, Math.max(1, node.children?.length || 1)) as 1 | 2 | 3} style={{ marginBottom: '0.5rem' }}>{node.children?.map((child, index) => renderNode(child, `${key}-${index}`, groupContext))}</ClinicalGrid>;
    if (node.type === 'column') return <div key={key} style={{ minWidth: 0 }}>{node.children?.map((child, index) => renderNode(child, `${key}-${index}`, groupContext))}</div>;
    if (node.type === 'container' || node.type === 'form' || node.type === 'section' || node.type === 'tab') {
      const componentKind = node.type === 'container' ? 'groups' : node.type === 'section' ? 'sections' : node.type === 'tab' ? 'tabs' : 'forms';
      const componentId = id || '';
      const dynamic = uiStates[`${componentKind}:${componentId}`];
      if (dynamic?.visible === false) return null;
      // Only a container/section/tab that actually has a label is worth its
      // own bordered box + heading - an unlabeled wrapper (e.g. the single
      // top-level container every Form Section's layout starts with) would
      // otherwise draw an empty, heading-less box around everything else,
      // one more nested "box in a box" with nothing to show for it.
      const decorated = node.type !== 'form' && Boolean(node.label);

      if (node.type === 'container' && node.repeatable === true && id) {
        const descriptor = groupById.get(id);
        const rows = rowsOf(values[id]);
        const rowKeys = rowKeysFor(id, rows.length);
        const maximumReached = descriptor?.repeatMax !== -1
          && descriptor?.repeatMax !== undefined
          && rows.length >= descriptor.repeatMax;
        const groupDisabled = readOnly || dynamic?.enabled === false || dynamic?.readonly === true;
        const addRow = () => {
          markChanged(id);
          const row: GroupRow = {};
          fields.filter((field) => field.repeatableGroupId === id && field.defaultValue !== undefined).forEach((field) => {
            row[field.id] = field.repeatable ? [field.defaultValue] : field.defaultValue;
          });
          replaceGroupRows(id, [...rows, row], { type: 'add', index: rows.length, item: row });
        };
        // Duplicate: a deep-ish copy (repeatable sub-fields' own arrays
        // still need their own new array, same reasoning as
        // buildRepeatableDefaults' shallow-copy fix elsewhere) so editing
        // the copy never mutates the source row through a shared reference.
        const duplicateRow = (index: number) => {
          markChanged(id);
          const source = rows[index];
          const copy: GroupRow = {};
          Object.entries(source).forEach(([fieldId, fieldValue]) => {
            copy[fieldId] = Array.isArray(fieldValue) ? [...fieldValue] : fieldValue;
          });
          const nextRows = rows.slice();
          nextRows.splice(index + 1, 0, copy);
          insertRowKeyAfter(id, index);
          replaceGroupRows(id, nextRows, { type: 'add', index: index + 1, item: copy });
        };
        // Reorder: swaps two adjacent rows in place - no add/remove Form
        // Script event fires (nothing was added or removed, see
        // replaceGroupRows' own `!action` branch), just a plain values sync.
        const moveRow = (index: number, direction: -1 | 1) => {
          const target = index + direction;
          if (target < 0 || target >= rows.length) return;
          markChanged(id);
          const nextRows = rows.slice();
          [nextRows[index], nextRows[target]] = [nextRows[target], nextRows[index]];
          swapRowKeys(id, index, target);
          replaceGroupRows(id, nextRows);
        };
        const rowActions = (index: number, row: GroupRow) => (
          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
            <button
              type="button"
              title="Nach oben verschieben"
              aria-label="Nach oben verschieben"
              disabled={groupDisabled || index === 0}
              onClick={() => moveRow(index, -1)}
              style={{ border: 0, background: 'transparent', color: '#475569', cursor: 'pointer', padding: '0.15rem 0.4rem' }}
            >
              ↑
            </button>
            <button
              type="button"
              title="Nach unten verschieben"
              aria-label="Nach unten verschieben"
              disabled={groupDisabled || index === rows.length - 1}
              onClick={() => moveRow(index, 1)}
              style={{ border: 0, background: 'transparent', color: '#475569', cursor: 'pointer', padding: '0.15rem 0.4rem' }}
            >
              ↓
            </button>
            <button
              type="button"
              disabled={groupDisabled || maximumReached}
              onClick={() => duplicateRow(index)}
              style={{ border: 0, background: 'transparent', color: '#475569', cursor: 'pointer' }}
            >
              Duplizieren
            </button>
            <button
              type="button"
              disabled={groupDisabled || rows.length <= (descriptor?.repeatMin || 0)}
              onClick={() => {
                markChanged(id);
                removeRowKey(id, index);
                replaceGroupRows(
                  id,
                  rows.filter((_item, itemIndex) => itemIndex !== index),
                  { type: 'remove', index, item: row },
                );
              }}
              style={{ border: 0, background: 'transparent', color: '#b91c1c', cursor: 'pointer' }}
            >
              Entfernen
            </button>
          </div>
        );
        const addRowButton = <button type="button" disabled={groupDisabled || maximumReached} onClick={addRow} style={{ border: '1px dashed #94a3b8', background: 'transparent', borderRadius: '6px', padding: '0.45rem 0.75rem', color: '#475569', cursor: 'pointer' }}>+ Eintrag hinzufügen</button>;
        const groupIssuesFooter = validation.issues.filter((issue) => issue.path === id && (alwaysShowValidation || (isBlockingIssue(issue) ? submitted : touchedFields[id] !== undefined))).map((issue, index) => {
          const warning = !isBlockingIssue(issue);
          return (
            <div
              key={`${id}-group-issue-${index}`}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.35rem', marginTop: '0.35rem',
                fontSize: '0.8rem', color: warning ? '#b45309' : '#b91c1c', background: warning ? '#fef3c7' : '#fee2e2',
                border: `1px solid ${warning ? '#fde68a' : '#fecaca'}`, borderRadius: '5px', padding: '0.3rem 0.55rem',
              }}
            >
              <span aria-hidden="true">{warning ? '⚠' : '⨯'}</span>
              <span>{issue.message}</span>
            </div>
          );
        });

        // Table mode (P0.2 audit, 2026-09-05): one column per LEAF field,
        // flattening through any row/column/plain-container wrappers (see
        // collectTableColumns) - a repeatable CLUSTER of short, simple
        // fields (a medication list, a lab-result panel) is often more
        // naturally scanned as a table than scrolled through as N separate
        // cards. Falls back to the existing card layout below whenever
        // displayMode isn't explicitly 'table' - fully opt-in, no visual
        // change for any existing form.
        if (node.displayMode === 'table') {
          const columns = collectTableColumns(node);
          return (
            <section key={key} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h3 style={{ margin: 0 }}>{node.label || id}</h3>
                <ExtensionSlot name="form:group:actions" context={{ groupId: id, label: node.label, readOnly: groupDisabled }} />
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {columns.map((column, columnIndex) => {
                        const columnField = fieldById.get(idOf(column) || '');
                        return (
                          <th key={idOf(column) || columnIndex} style={{ textAlign: 'left', padding: '0.4rem 0.5rem', borderBottom: '2px solid #e2e8f0', fontSize: '0.85rem', color: '#475569' }}>
                            {columnField?.label || column.label || idOf(column)}
                            {columnField?.required && <span style={{ color: '#dc2626' }}> *</span>}
                          </th>
                        );
                      })}
                      <th style={{ borderBottom: '2px solid #e2e8f0' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={rowKeys[index]} style={{ background: index % 2 === 1 ? '#f8fafc' : undefined }}>
                        {columns.map((column, columnIndex) => (
                          <td key={idOf(column) || columnIndex} style={{ padding: '0.4rem 0.5rem', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top' }}>
                            {renderField(column, { groupId: id, index, row, disabled: groupDisabled }, true)}
                          </td>
                        ))}
                        <td style={{ padding: '0.4rem 0.5rem', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap' }}>{rowActions(index, row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: '0.75rem' }}>{addRowButton}</div>
              {groupIssuesFooter}
            </section>
          );
        }

        return (
          <section key={key} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h3 style={{ margin: 0 }}>{node.label || id}</h3>
              <ExtensionSlot name="form:group:actions" context={{ groupId: id, label: node.label, readOnly: groupDisabled }} />
            </div>
            {rows.map((row, index) => (
              <div key={rowKeys[index]} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginBottom: '0.75rem', background: '#f8fafc' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <strong>{node.label || id} {index + 1}</strong>
                  {rowActions(index, row)}
                </div>
                {node.children?.map((child, childIndex) => renderNode(child, `${key}-${index}-${childIndex}`, {
                  groupId: id,
                  index,
                  row,
                  disabled: groupDisabled,
                }))}
              </div>
            ))}
            {addRowButton}
            {groupIssuesFooter}
          </section>
        );
      }

      return (
        <section key={key} style={{ border: decorated ? '1px solid #e2e8f0' : undefined, borderRadius: decorated ? '8px' : undefined, padding: decorated ? '1rem' : undefined, marginBottom: '1rem' }}>
          {decorated && node.label && <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}><h3 style={{ margin: 0 }}>{node.label}</h3>{node.type === 'container' && <ExtensionSlot name="form:group:actions" context={{ groupId: componentId, label: node.label, readOnly }} />}</div>}
          {node.children?.map((child, index) => renderNode(child, `${key}-${index}`, groupContext))}
        </section>
      );
    }
    return renderField(node, groupContext);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const client = scriptClientRef.current;
    if (client) {
      const errors = await client.validate(valuesRef.current);
      setScriptErrors(errors);
      if (Object.keys(errors).length > 0) {
        setToast({ level: 'error', message: 'Die Script-Validierung enthält Fehler.' });
        return;
      }
      const validationEvent = await client.runLifecycle('onValidation', valuesRef.current);
      if (validationEvent.cancelled) {
        setToast({ level: 'error', message: validationEvent.message || 'Die Script-Validierung ist fehlgeschlagen.' });
        return;
      }
    }
    if (!validation.valid) return;
    if (client) {
      const before = await client.runLifecycle('beforeSubmit', valuesRef.current);
      if (before.cancelled) {
        setToast({ level: 'error', message: before.message || 'Das Absenden wurde vom Form Script abgebrochen.' });
        return;
      }
    }
    try {
      await onSubmit?.(persistentValues());
      await client?.runLifecycle('afterSubmit', valuesRef.current);
    } catch (error) {
      setToast({
        level: 'error',
        message: error instanceof Error ? error.message : 'Das Formular konnte nicht abgesendet werden.',
      });
    }
  };

  const formContent = (
    // autoComplete="off" (plus autoComplete="off" repeated on the individual
    // free-text/textarea inputs below - browsers, Chrome especially, don't
    // reliably honor the form-level opt-out alone for fields with no
    // semantic autocomplete token) - confirmed live (2026-09-02): Chrome's
    // own autofill silently pre-filled clinical fields (diagnosis text,
    // medication name, dosing) with values typed into a same-shaped field
    // earlier in the browser session, for a DIFFERENT patient. In a
    // clinical documentation tool that's a real risk of a clinician
    // unknowingly submitting stale/wrong data - never something to leave to
    // browser heuristics.
    <form autoComplete="off" onSubmit={(event) => void submit(event)} style={{ maxWidth: chromeless ? '100%' : '960px', margin: chromeless ? 0 : '0 auto' }}>
      <div style={chromeless ? { padding: 0 } : { background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.5rem' }}>
        {toast && <div role={toast.level === 'error' ? 'alert' : 'status'} style={{ marginBottom: '1rem', padding: '0.75rem 1rem', borderRadius: '8px', background: toast.level === 'error' ? '#fef2f2' : toast.level === 'success' ? '#f0fdf4' : '#eff6ff', color: toast.level === 'error' ? '#b91c1c' : toast.level === 'success' ? '#15803d' : '#1d4ed8', display: 'flex', justifyContent: 'space-between', gap: '1rem' }}><span>{toast.message}</span><button type="button" aria-label="Meldung schließen" onClick={() => setToast(null)} style={{ border: 0, background: 'transparent', cursor: 'pointer' }}>×</button></div>}
        {showHeader && definition.name && <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}><div><h1 style={{ margin: 0 }}>{definition.name}</h1><div style={{ color: '#64748b', fontSize: '0.85rem' }}>Version {definition.version}</div></div><ExtensionSlot name="form:header:actions" context={{ readOnly }} /></header>}
        {renderNode(definition.layout, 'root')}
        {showSubmit && !readOnly && <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}><button type="submit" className="btn" disabled={busy || (submitted && !validation.valid)}>{submitLabel}</button></div>}
        {submitted && !validation.valid && <div role="alert" style={{ color: '#b91c1c', marginTop: '0.75rem' }}>{validation.issues.filter(isBlockingIssue).length} Validierungsfehler müssen korrigiert werden.</div>}
      </div>
      <ExtensionSlot name="form:overlay" context={{ readOnly }} />
    </form>
  );

  return (
    <ExtensionWrapperSlot name="form:wrapper" context={{ values, setValues, definition, patientId, ehrId, encounterId }}>
      {formContent}
      <PrefillConflictDialog conflicts={pendingPrefillConflicts} onResolve={resolvePrefillConflicts} />
    </ExtensionWrapperSlot>
  );
});

export default FormRuntime;
