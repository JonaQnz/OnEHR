import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import type { CanonicalForm, FormDefinitionV1, FormElementLayout, RuntimeFieldDescriptor, RuntimeValues, RuntimeValidationIssue } from 'core';
import * as CoreRuntime from 'core';
import { ExtensionSlot, ExtensionWrapperSlot } from './FrontendPluginRegistry';

type RuntimeDefinition = CanonicalForm | FormDefinitionV1;

export interface RuntimeRendererProps {
  field: RuntimeFieldDescriptor;
  node: FormElementLayout;
  value: unknown;
  error?: RuntimeValidationIssue;
  disabled: boolean;
  onChange: (value: any) => void;
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
  rendererOverrides?: Record<string, RuntimeRenderer>;
  onValuesChange?: (values: RuntimeValues) => void;
  onSubmit?: (values: RuntimeValues) => void;
}

function idOf(node: FormElementLayout): string | undefined { return node.id || node.name; }

function inputType(node: FormElementLayout): string {
  if (node.type === 'input-date-time') return 'datetime-local';
  if (node.type === 'input-time') return 'time';
  if (node.type === 'input-date') return 'date';
  if (node.type === 'input-number' || node.type === 'input-proportion') return 'number';
  return 'text';
}

export default function FormRuntime({
  definition,
  initialValues,
  readOnly = false,
  busy = false,
  showSubmit = true,
  submitLabel = 'Formular absenden',
  patientId,
  ehrId,
  encounterId,
  rendererOverrides = {},
  onValuesChange,
  onSubmit,
}: FormRuntimeProps) {
  const fields = useMemo(() => CoreRuntime.collectRuntimeFields(definition), [definition]);
  const fieldById = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);
  const [values, setValues] = useState<RuntimeValues>(() => ({ ...CoreRuntime.createInitialRuntimeValues(definition), ...initialValues }));
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setValues({ ...CoreRuntime.createInitialRuntimeValues(definition), ...initialValues });
    setSubmitted(false);
  }, [definition, initialValues]);

  useEffect(() => { onValuesChange?.(values); }, [values, onValuesChange]);

  const validation = useMemo(() => CoreRuntime.validateRuntimeValues(definition, values), [definition, values]);

  const update = (id: string, value: any) => {
    setValues((previous) => ({ ...previous, [id]: value }));
  };

  const issuesFor = (id: string) => validation.issues.filter((issue: any) => issue.path === id || issue.path.startsWith(`${id}[`));

  const fieldInput = (field: RuntimeFieldDescriptor, node: FormElementLayout, value: any, onChange: (next: any) => void, error?: RuntimeValidationIssue): ReactNode => {
    const disabled = readOnly || field.readOnly;
    const override = rendererOverrides[field.type] || rendererOverrides[node.uiElement || ''];
    if (override) return override({ field, node, value, error, disabled, onChange });
    const invalid = Boolean(error);
    const style = { width: '100%', padding: '0.55rem 0.7rem', border: `1px solid ${invalid ? '#dc2626' : '#cbd5e1'}`, borderRadius: '6px', background: disabled ? '#f8fafc' : 'white' };
    const eventValue = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange(event.target.value);

    if (node.uiElement === 'Checkboxes' && field.options.length > 0) {
      const selected = Array.isArray(value) ? value : [];
      return <div style={{ display: 'grid', gap: '0.4rem' }}>{field.options.map((option) => <label key={option.value} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><input type="checkbox" disabled={disabled} checked={selected.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />{option.text}</label>)}</div>;
    }
    if (node.uiElement === 'RadioButtons' && field.options.length > 0) {
      return <div style={{ display: 'grid', gap: '0.4rem' }}>{field.options.map((option) => <label key={option.value} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><input type="radio" name={field.id} disabled={disabled} checked={value === option.value} onChange={() => onChange(option.value)} />{option.text}</label>)}</div>;
    }
    if (node.uiElement === 'TextArea') return <textarea style={{ ...style, minHeight: '7rem', resize: 'vertical' }} disabled={disabled} value={value ?? ''} placeholder={node.placeholder || ''} onChange={eventValue} />;
    if (node.uiElement === 'Dropdown' || node.type === 'input-select' || node.type === 'input-ordinal') {
      return <select style={style} disabled={disabled} multiple={Array.isArray(value)} value={value ?? (Array.isArray(value) ? [] : '')} onChange={(event) => onChange(event.target.multiple ? Array.from(event.target.selectedOptions, (option) => option.value) : event.target.value)}><option value="">Bitte auswählen</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.text}</option>)}</select>;
    }
    if (node.type === 'input-boolean' || node.uiElement === 'Checkbox') return <label style={{ display: 'flex', gap: '0.55rem', alignItems: 'center' }}><input type="checkbox" disabled={disabled} checked={value === true} onChange={(event) => onChange(event.target.checked)} />Ja</label>;
    if (node.type === 'input-quantity') {
      const quantity = value && typeof value === 'object' ? value : {};
      return <div style={{ display: 'flex', gap: '0.5rem' }}><input style={{ ...style, flex: 1 }} type="number" disabled={disabled} value={quantity.magnitude ?? ''} onChange={(event) => onChange({ ...quantity, magnitude: event.target.value })} />{field.unitOptions.length > 0 ? <select style={{ ...style, maxWidth: '10rem' }} disabled={disabled} value={quantity.unit || ''} onChange={(event) => onChange({ ...quantity, unit: event.target.value })}><option value="">Einheit</option>{field.unitOptions.map((option) => <option key={option.unit} value={option.unit}>{option.unit}</option>)}</select> : null}</div>;
    }
    if (node.uiElement === 'Range' || node.type === 'input-range') return <input style={style} type="range" disabled={disabled} min={node.min_value ?? field.validation?.min ?? 0} max={node.max_value ?? field.validation?.max ?? 100} step={node.step ?? 1} value={value ?? node.min_value ?? 0} onChange={(event) => onChange(Number(event.target.value))} />;
    return <input style={style} type={inputType(node)} disabled={disabled} value={value ?? ''} placeholder={node.placeholder || ''} onChange={eventValue} />;
  };

  const renderField = (node: FormElementLayout): ReactNode => {
    const id = idOf(node);
    if (!id) return null;
    const field = fieldById.get(id);
    if (!field || !CoreRuntime.isRuntimeFieldVisible(field, values)) return null;
    const nodeIssues = issuesFor(id);

    const renderSingle = (value: any, index?: number) => {
      const issueForValue = index === undefined ? nodeIssues[0] : nodeIssues.find((issue) => issue.path === `${id}[${index}]`);
      const key = index === undefined ? id : `${id}-${index}`;
      return <div key={key} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}><div style={{ flex: 1 }}>{fieldInput(field, node, value, (next) => { if (index === undefined) update(id, next); else { const list = Array.isArray(values[id]) ? [...values[id] as any[]] : []; list[index] = next; update(id, list); } }, issueForValue)}</div>{index !== undefined && <button type="button" disabled={readOnly} onClick={() => update(id, (Array.isArray(values[id]) ? values[id] as any[] : []).filter((_item, itemIndex) => itemIndex !== index))} style={{ border: 0, background: 'transparent', color: '#64748b', cursor: 'pointer', padding: '0.5rem' }}>×</button>}</div>;
    };

    const repeated = field.repeatable ? (Array.isArray(values[id]) ? values[id] as any[] : []) : [];
    const displayValues = field.repeatable && repeated.length === 0 && field.repeatMin > 0 ? Array.from({ length: field.repeatMin }, () => undefined) : repeated;

    return (
      <div key={id} style={{ marginBottom: '1.15rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
          <label style={{ fontWeight: 600, margin: 0 }}>
            {field.label}
            {field.required && <span style={{ color: '#dc2626' }}> *</span>}
          </label>

          <ExtensionSlot name="form:field:actions" context={{ fieldId: id, readOnly }} />
        </div>

        {field.description && <div style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '0.4rem' }}>{field.description}</div>}
        {field.repeatable ? <>{displayValues.map((value, index) => renderSingle(value, index))}<button type="button" disabled={readOnly || (field.repeatMax !== -1 && repeated.length >= field.repeatMax)} onClick={() => update(id, [...repeated, undefined])} style={{ border: '1px dashed #94a3b8', background: 'transparent', borderRadius: '6px', padding: '0.45rem 0.75rem', color: '#475569', cursor: 'pointer' }}>+ {field.label}</button></> : renderSingle(values[id])}
        {submitted && nodeIssues[0] && <div style={{ color: '#dc2626', fontSize: '0.8rem', marginTop: '0.3rem' }}>{nodeIssues[0].message}</div>}
      </div>
    );
  };

  const renderNode = (node: FormElementLayout, key: string): ReactNode => {
    if (node.type === 'header') return <h2 key={key}>{node.content}</h2>;
    if (node.type === 'paragraph') return <p key={key} style={{ color: '#475569' }}>{node.content}</p>;
    if (node.type === 'line-break') return <hr key={key} />;
    if (node.type === 'row') return <div key={key} style={{ display: 'grid', gridTemplateColumns: `repeat(${node.children?.length || 1}, minmax(0, 1fr))`, gap: '1rem', marginBottom: '0.5rem' }}>{node.children?.map((child, index) => renderNode(child, `${key}-${index}`))}</div>;
    if (node.type === 'column') return <div key={key} style={{ minWidth: 0 }}>{node.children?.map((child, index) => renderNode(child, `${key}-${index}`))}</div>;

    if (node.type === 'container' || node.type === 'form') {
      const containerId = node.id || node.name || '';

      return (
        <section
          key={key}
          style={{
            border: node.type === 'container' ? '1px solid #e2e8f0' : undefined,
            borderRadius: node.type === 'container' ? '8px' : undefined,
            padding: node.type === 'container' ? '1rem' : undefined,
            marginBottom: '1rem',
          }}
        >
          {node.type === 'container' && node.label && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <h3 style={{ marginTop: 0, marginBottom: 0 }}>{node.label}</h3>

              <ExtensionSlot name="form:group:actions" context={{ groupId: containerId, label: node.label, readOnly }} />
            </div>
          )}
          {node.children?.map((child, index) => renderNode(child, `${key}-${index}`))}
        </section>
      );
    }

    return renderField(node);
  };

  const submit = (event: FormEvent) => { event.preventDefault(); setSubmitted(true); if (validation.valid) onSubmit?.(values); };

  const formContent = (
    <form onSubmit={submit} style={{ maxWidth: '960px', margin: '0 auto' }}>
      <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.5rem' }}>
        {definition.name && (
          <header style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <h1 style={{ margin: 0 }}>{definition.name}</h1>
              <div style={{ color: '#64748b', fontSize: '0.85rem' }}>Version {definition.version}</div>
            </div>

            <ExtensionSlot name="form:header:actions" context={{ readOnly }} />
          </header>
        )}

        {renderNode(definition.layout, 'root')}

        {showSubmit && !readOnly && (
          <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn" disabled={busy || (submitted && !validation.valid)}>
              {submitLabel}
            </button>
          </div>
        )}

        {submitted && !validation.valid && (
          <div role="alert" style={{ color: '#b91c1c', marginTop: '0.75rem' }}>
            {validation.issues.length} Validierungsfehler müssen korrigiert werden.
          </div>
        )}
      </div>
      <ExtensionSlot name="form:overlay" context={{ readOnly }} />
    </form>
  );

  return (
    <ExtensionWrapperSlot 
      name="form:wrapper" 
      context={{ values, setValues, definition, patientId, ehrId, encounterId }}
    >
      {formContent}
    </ExtensionWrapperSlot>
  );
}
