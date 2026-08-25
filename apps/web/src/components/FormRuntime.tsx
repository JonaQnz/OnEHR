import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
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
  /** Server-loaded data such as the last Flat Composition; never merged into form values. */
  runtimeContext?: FormSessionRuntimeContext;
  rendererOverrides?: Record<string, RuntimeRenderer>;
  onValuesChange?: (values: RuntimeValues) => void;
  mode?: 'create' | 'edit' | 'view' | 'preview' | 'prefill';
  onSubmit?: (values: RuntimeValues) => void | Promise<void>;
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
  runtimeContext,
  rendererOverrides = {},
  onValuesChange,
  onSubmit,
  mode = 'preview',
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
      .catch((error: Error) => setToast({ level: 'error', message: error.message }));

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
    return <input style={style} type={inputType(node)} disabled={disabled} value={String(value ?? '')} placeholder={node.placeholder || ''} onChange={eventValue} />;
  };

  const renderField = (node: FormElementLayout, groupContext?: GroupContext): ReactNode => {
    const id = idOf(node);
    if (!id) return null;
    const field = fieldById.get(id);
    const dynamic = uiStates[`fields:${id}`];
    if (!field || (!field.required && hiddenFieldIds.includes(id)) || !CoreRuntime.isRuntimeFieldVisible(field, values) || dynamic?.visible === false) return null;
    const effectiveField: RuntimeFieldDescriptor = {
      ...field,
      label: dynamic?.label || field.label,
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
      const decorated = node.type !== 'form';

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
    <form onSubmit={(event) => void submit(event)} style={{ maxWidth: '960px', margin: '0 auto' }}>
      <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.5rem' }}>
        {toast && <div role={toast.level === 'error' ? 'alert' : 'status'} style={{ marginBottom: '1rem', padding: '0.75rem 1rem', borderRadius: '8px', background: toast.level === 'error' ? '#fef2f2' : toast.level === 'success' ? '#f0fdf4' : '#eff6ff', color: toast.level === 'error' ? '#b91c1c' : toast.level === 'success' ? '#15803d' : '#1d4ed8', display: 'flex', justifyContent: 'space-between', gap: '1rem' }}><span>{toast.message}</span><button type="button" aria-label="Meldung schließen" onClick={() => setToast(null)} style={{ border: 0, background: 'transparent', cursor: 'pointer' }}>×</button></div>}
        {definition.name && <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}><div><h1 style={{ margin: 0 }}>{definition.name}</h1><div style={{ color: '#64748b', fontSize: '0.85rem' }}>Version {definition.version}</div></div><ExtensionSlot name="form:header:actions" context={{ readOnly }} /></header>}
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
