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
} from 'core';
import * as CoreRuntime from 'core';
import { ExtensionSlot, ExtensionWrapperSlot, useFrontendPlugins } from './FrontendPluginRegistry';
import { ClinicalGrid } from './layout/ClinicalLayout';
import {
  FormScriptClient,
  type FormScriptLifecycleResult,
  type FormScriptUiState,
} from '../scripting/runtime/FormScriptClient';

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
  error?: RuntimeValidationIssue;
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
}

export interface FormRuntimeHandle {
  runLifecycle(name: FormScriptEventName): Promise<FormScriptLifecycleResult>;
  applyValues(values: RuntimeValues, source?: FormScriptChangeSource, emitChanges?: boolean): void;
  getValues(): RuntimeValues;
}

function idOf(node: FormElementLayout): string | undefined {
  return node.id || node.name;
}

function inputType(node: FormElementLayout): string {
  if (node.type === 'input-date-time') return 'datetime-local';
  if (node.type === 'input-time') return 'time';
  if (node.type === 'input-date') return 'date';
  if (node.type === 'input-number' || node.type === 'input-proportion') return 'number';
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
    return <input style={style} type="text" disabled={disabled} value={String(value ?? '')} placeholder="Freitext eingeben …" onChange={(event) => onChange(event.target.value)} />;
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
  const [scriptErrors, setScriptErrors] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ level: string; message: string } | null>(null);
  const valuesRef = useRef(values);
  const nonPersistedIdsRef = useRef(new Set<string>());
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
      onSetValue: (id, value, persist) => {
        if (persist) nonPersistedIdsRef.current.delete(id);
        else nonPersistedIdsRef.current.add(id);
        setValues((previous) => {
          const next = { ...previous, [id]: value as never };
          valuesRef.current = next;
          return next;
        });
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

    Object.entries(scriptErrors).forEach(([path, message]) => {
      issues.push({ path, code: 'type', message });
    });
    return { valid: issues.length === 0, issues };
  }, [definition, fields, scriptErrors, uiStates, values]);

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
    error?: RuntimeValidationIssue,
    inputName = field.id,
  ): ReactNode => {
    const dynamic = uiStates[`fields:${field.id}`];
    const disabled = readOnly || dynamic?.enabled === false || dynamic?.readonly === true || field.readOnly;
    const override = effectiveRendererOverrides[field.type] || effectiveRendererOverrides[node.uiElement || ''];
    if (override) return override({ field, node, value, error, disabled, onChange });
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
    if (node.uiElement === 'TextArea') return <textarea style={{ ...style, minHeight: '7rem', resize: 'vertical' }} disabled={disabled} value={String(value ?? '')} placeholder={node.placeholder || ''} onChange={eventValue} />;
    if (node.uiElement === 'Dropdown' || node.type === 'input-select' || node.type === 'input-ordinal') {
      const selectedValue = Array.isArray(value) ? value.map(String) : String(value ?? '');
      return <select style={style} disabled={disabled} multiple={Array.isArray(value)} value={selectedValue} onChange={(event) => onChange(event.target.multiple ? Array.from(event.target.selectedOptions, (option) => option.value) : event.target.value)}><option value="">Bitte auswählen</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.text}</option>)}</select>;
    }
    if (node.type === 'input-boolean' || node.uiElement === 'Checkbox') return <label style={{ display: 'flex', gap: '0.55rem', alignItems: 'center' }}><input type="checkbox" disabled={disabled} checked={value === true} onChange={(event) => onChange(event.target.checked)} />Ja</label>;
    if (node.type === 'input-quantity') {
      const quantity = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      return <div style={{ display: 'flex', gap: '0.5rem' }}><input style={{ ...style, flex: 1 }} type="number" disabled={disabled} value={String(quantity.magnitude ?? '')} onChange={(event) => onChange({ ...quantity, magnitude: event.target.value === '' ? null : Number(event.target.value) })} />{field.unitOptions.length > 0 ? <select style={{ ...style, maxWidth: '10rem' }} disabled={disabled} value={String(quantity.unit || '')} onChange={(event) => onChange({ ...quantity, unit: event.target.value })}><option value="">Einheit</option>{field.unitOptions.map((option) => <option key={option.unit} value={option.unit}>{option.unit}</option>)}</select> : null}</div>;
    }
    if (node.uiElement === 'Range' || node.type === 'input-range') return <input style={style} type="range" disabled={disabled} min={node.min_value ?? field.validation?.min ?? 0} max={node.max_value ?? field.validation?.max ?? 100} step={node.step ?? 1} value={Number(value ?? node.min_value ?? 0)} onChange={(event) => onChange(Number(event.target.value))} />;
    if (field.codeMappings?.enabled) {
      // {value, mappings?} (core.CodeMappedTextValue) instead of a plain
      // string - the text field itself is untouched, mappings render as
      // extra rows below it. Terminology is always designer-configured
      // (field.codeMappings.terminologies) - the clinician only ever
      // types/edits the code itself, per "Katalog hidden": no visible
      // terminology browser, just a code entry per configured terminology.
      const compound = (value && typeof value === 'object' && !Array.isArray(value)) ? value as { value?: unknown; mappings?: Array<{ terminologyId: string; code: string; match?: string }> } : { value };
      const text = compound.value;
      const mappings = Array.isArray(compound.mappings) ? compound.mappings : [];
      const terminologies = field.codeMappings.terminologies;
      const commitMappings = (next: typeof mappings) => onChange({ value: text, ...(next.length > 0 ? { mappings: next } : {}) });
      const canAddMore = terminologies.length > 0 && (field.codeMappings.allowMultiple !== false || mappings.length === 0);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <input style={style} type={inputType(node)} disabled={disabled} value={String(text ?? '')} placeholder={node.placeholder || ''} onChange={(event) => onChange({ value: event.target.value, ...(mappings.length > 0 ? { mappings } : {}) })} />
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
                <input style={{ ...style, flex: 1, padding: '0.4rem 0.6rem' }} type="text" disabled={disabled} value={mapping.code} placeholder="Code" onChange={(event) => commitMappings(mappings.map((item, i) => i === index ? { ...item, code: event.target.value } : item))} />
                <button type="button" disabled={disabled} title="Zuordnung entfernen" onClick={() => commitMappings(mappings.filter((_item, i) => i !== index))} style={{ border: 0, background: 'transparent', color: '#64748b', cursor: 'pointer', padding: '0.3rem' }}>×</button>
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
    return <input style={style} type={inputType(node)} disabled={disabled} value={String(value ?? '')} placeholder={node.placeholder || ''} onChange={eventValue} />;
  };

  const renderField = (node: FormElementLayout, groupContext?: GroupContext): ReactNode => {
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
      const issueForValue = index === undefined
        ? nodeIssues[0]
        : nodeIssues.find((issue) => issue.path === `${basePath}[${index}]`);
      const key = index === undefined ? basePath : `${basePath}-${index}`;
      return (
        <div key={key} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
          <div
            style={{ flex: 1 }}
            onFocus={() => scriptClientRef.current?.uiEvent(id, 'focus')}
            onBlur={() => scriptClientRef.current?.uiEvent(id, 'blur')}
          >
            {fieldInput(effectiveField, effectiveNode, value, (next) => {
              if (index === undefined) {
                commit(next);
                return;
              }
              const list = Array.isArray(fieldValue) ? [...fieldValue] : [];
              list[index] = next;
              commit(list);
            }, issueForValue, groupContext ? `${id}-${groupContext.index}` : id)}
          </div>
          {index !== undefined && <button type="button" disabled={readOnly || groupContext?.disabled} onClick={() => commit((Array.isArray(fieldValue) ? fieldValue : []).filter((_item, itemIndex) => itemIndex !== index))} style={{ border: 0, background: 'transparent', color: '#64748b', cursor: 'pointer', padding: '0.5rem' }}>×</button>}
        </div>
      );
    };

    const repeated = field.repeatable ? (Array.isArray(fieldValue) ? fieldValue : []) : [];
    const displayValues = field.repeatable && repeated.length === 0 && field.repeatMin > 0
      ? Array.from({ length: field.repeatMin }, () => undefined)
      : repeated;

    return (
      <div key={basePath} style={{ marginBottom: '1.15rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
          <label style={{ fontWeight: 600, margin: 0 }}>
            {effectiveField.label}
            {effectiveField.required && <span style={{ color: '#dc2626' }}> *</span>}
          </label>
          <ExtensionSlot name="form:field:actions" context={{ fieldId: id, groupId: groupContext?.groupId, rowIndex: groupContext?.index, readOnly }} />
        </div>
        {effectiveField.description && <div style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '0.4rem' }}>{effectiveField.description}</div>}
        {effectiveField.repeatable ? <>{displayValues.map((item, index) => renderSingle(item, index))}<button type="button" disabled={readOnly || groupContext?.disabled || (effectiveField.repeatMax !== -1 && repeated.length >= effectiveField.repeatMax)} onClick={() => commit([...repeated, undefined])} style={{ border: '1px dashed #94a3b8', background: 'transparent', borderRadius: '6px', padding: '0.45rem 0.75rem', color: '#475569', cursor: 'pointer' }}>+ {effectiveField.label}</button></> : renderSingle(fieldValue)}
        {submitted && nodeIssues[0] && <div style={{ color: '#dc2626', fontSize: '0.8rem', marginTop: '0.3rem' }}>{nodeIssues[0].message}</div>}
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
        const maximumReached = descriptor?.repeatMax !== -1
          && descriptor?.repeatMax !== undefined
          && rows.length >= descriptor.repeatMax;
        const groupDisabled = readOnly || dynamic?.enabled === false || dynamic?.readonly === true;
        const addRow = () => {
          const row: GroupRow = {};
          fields.filter((field) => field.repeatableGroupId === id && field.defaultValue !== undefined).forEach((field) => {
            row[field.id] = field.repeatable ? [field.defaultValue] : field.defaultValue;
          });
          replaceGroupRows(id, [...rows, row], { type: 'add', index: rows.length, item: row });
        };
        return (
          <section key={key} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h3 style={{ margin: 0 }}>{node.label || id}</h3>
              <ExtensionSlot name="form:group:actions" context={{ groupId: id, label: node.label, readOnly: groupDisabled }} />
            </div>
            {rows.map((row, index) => (
              <div key={`${id}-${index}`} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginBottom: '0.75rem', background: '#f8fafc' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <strong>{node.label || id} {index + 1}</strong>
                  <button
                    type="button"
                    disabled={groupDisabled || rows.length <= (descriptor?.repeatMin || 0)}
                    onClick={() => replaceGroupRows(
                      id,
                      rows.filter((_item, itemIndex) => itemIndex !== index),
                      { type: 'remove', index, item: row },
                    )}
                    style={{ border: 0, background: 'transparent', color: '#b91c1c', cursor: 'pointer' }}
                  >
                    Entfernen
                  </button>
                </div>
                {node.children?.map((child, childIndex) => renderNode(child, `${key}-${index}-${childIndex}`, {
                  groupId: id,
                  index,
                  row,
                  disabled: groupDisabled,
                }))}
              </div>
            ))}
            <button type="button" disabled={groupDisabled || maximumReached} onClick={addRow} style={{ border: '1px dashed #94a3b8', background: 'transparent', borderRadius: '6px', padding: '0.45rem 0.75rem', color: '#475569', cursor: 'pointer' }}>+ Eintrag hinzufügen</button>
            {submitted && validation.issues.find((issue) => issue.path === id) && <div style={{ color: '#dc2626', fontSize: '0.8rem', marginTop: '0.3rem' }}>{validation.issues.find((issue) => issue.path === id)?.message}</div>}
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
    <form onSubmit={(event) => void submit(event)} style={{ maxWidth: chromeless ? '100%' : '960px', margin: chromeless ? 0 : '0 auto' }}>
      <div style={chromeless ? { padding: 0 } : { background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.5rem' }}>
        {toast && <div role={toast.level === 'error' ? 'alert' : 'status'} style={{ marginBottom: '1rem', padding: '0.75rem 1rem', borderRadius: '8px', background: toast.level === 'error' ? '#fef2f2' : toast.level === 'success' ? '#f0fdf4' : '#eff6ff', color: toast.level === 'error' ? '#b91c1c' : toast.level === 'success' ? '#15803d' : '#1d4ed8', display: 'flex', justifyContent: 'space-between', gap: '1rem' }}><span>{toast.message}</span><button type="button" aria-label="Meldung schließen" onClick={() => setToast(null)} style={{ border: 0, background: 'transparent', cursor: 'pointer' }}>×</button></div>}
        {showHeader && definition.name && <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}><div><h1 style={{ margin: 0 }}>{definition.name}</h1><div style={{ color: '#64748b', fontSize: '0.85rem' }}>Version {definition.version}</div></div><ExtensionSlot name="form:header:actions" context={{ readOnly }} /></header>}
        {renderNode(definition.layout, 'root')}
        {showSubmit && !readOnly && <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}><button type="submit" className="btn" disabled={busy || (submitted && !validation.valid)}>{submitLabel}</button></div>}
        {submitted && !validation.valid && <div role="alert" style={{ color: '#b91c1c', marginTop: '0.75rem' }}>{validation.issues.length} Validierungsfehler müssen korrigiert werden.</div>}
      </div>
      <ExtensionSlot name="form:overlay" context={{ readOnly }} />
    </form>
  );

  return (
    <ExtensionWrapperSlot name="form:wrapper" context={{ values, setValues, definition, patientId, ehrId, encounterId }}>
      {formContent}
    </ExtensionWrapperSlot>
  );
});

export default FormRuntime;
