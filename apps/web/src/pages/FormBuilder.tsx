import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import FormBuilders, { ReactFormBuilder, FormElementsEdit, ElementKinds } from 'react-form-builder2';
const ElementStore = FormBuilders.ElementStore;
import { IntlProvider } from 'react-intl';
import enMessages from '../../../../packages/react-form-builder2/src/language-provider/locales/en-us.json';
import { useDrag } from 'react-dnd';
import 'react-form-builder2/dist/app.css';
import '../styles/builder-theme.css';
import '../styles/workbench.css';
import { canonicalToFormBuilder, formBuilderToCanonical, getElementText, hydrateCustomBuilderElements } from '../adapters/formBuilderAdapter';
import { validateForm, exportToOpenEhrFlatJson, getInstanceTitle } from '../utils/formStateHelper';
import PluginHost from '../components/PluginHost';
import { ExtensionSlot, useFrontendPlugins } from '../components/FrontendPluginRegistry';
import FormRuntime from '../components/FormRuntime';
import ScriptEditor from '../scripting/editor/ScriptEditor';
import ScriptLogs from '../scripting/editor/ScriptLogs';
import { DesignerShell } from '../designer/DesignerShell';

function LiveJsonEditor({ form, onSave }: { form: any, onSave: (f: any, items: any[]) => void }) {
  const [jsonString, setJsonString] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setJsonString(JSON.stringify(form.canonical_json, null, 2));
  }, [form]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setJsonString(val);
    try {
      const parsed = JSON.parse(val);
      setError(null);
      const items = canonicalToFormBuilder(parsed);
      const newForm = { ...form, canonical_json: parsed };
      onSave(newForm, items);
      
      fetch(`http://localhost:3001/api/forms/${form.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed)
      }).catch(err => console.error("Auto-save failed from JSON view:", err));

    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '1rem', backgroundColor: '#1e293b', color: '#f8fafc' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem', alignItems: 'center' }}>
        <strong style={{ fontSize: '1rem' }}>Live JSON Editor</strong>
        {error ? (
          <span style={{ color: '#ef4444', fontSize: '0.85rem', fontWeight: 600 }}>{error}</span>
        ) : (
          <span style={{ color: '#10b981', fontSize: '0.85rem', fontWeight: 600 }}>JSON is Valid (Auto-saving)</span>
        )}
      </div>
      <textarea
        style={{ flex: 1, backgroundColor: '#0f172a', color: '#f8fafc', border: '1px solid #334155', borderRadius: '8px', fontFamily: 'monospace', padding: '1rem', fontSize: '13px', outline: 'none', resize: 'none' }}
        value={jsonString}
        onChange={handleChange}
        spellCheck={false}
      />
    </div>
  );
}

function getUniqueFieldName(baseName: string, usedNames?: Set<string>): string {
  const data = (ElementStore as any).state?.data || [];
  let name = baseName;
  let counter = 1;
  const isUsed = (n: string) => (usedNames && usedNames.has(n)) || data.some((item: any) => item.field_name === n);
  while (isUsed(name)) {
    name = `${baseName}_${counter}`;
    counter++;
  }
  if (usedNames) {
    usedNames.add(name);
  }
  return name;
}

/** The one place that turns a template-panel FieldRegistryItem into an
 * OpenEhrBinding for a freshly-dropped field - used by both drag paths
 * below (single field, whole-group), so they can no longer silently
 * diverge in which sub-fields they carry. */
function fieldBinding(field: any) {
  return {
    templateAlias: field.templateAlias,
    path: field.openehrPath,
    rmType: field.rmType,
    ...(field.flatPath ? { flatPath: field.flatPath } : {}),
    ...(field.archetypeNodeId ? { archetypeNodeId: field.archetypeNodeId } : {}),
    ...(field.archetypeId ? { archetypeId: field.archetypeId } : {}),
    ...(field.rmVersion ? { rmVersion: field.rmVersion } : {}),
    ...(field.templateId ? { templateId: field.templateId } : {}),
  };
}

// Draggable node for openEHR Template tree fields
function DraggableFieldNode({ field, inForm }: { field: any; inForm: boolean }) {
  const rm = field.rmType || '';
  
  let element = 'TextInput';
  let customType = 'input-text';

  if (rm === 'DV_QUANTITY' || rm === 'DV_PROPORTION' || rm === 'DV_COUNT' || rm.includes('INTEGER')) {
    element = 'NumberInput';
    customType = rm === 'DV_QUANTITY' ? 'input-quantity' : 'input-proportion';
  } else if (rm === 'DV_CODED_TEXT' || rm === 'DV_ORDINAL' || rm === 'CODE_PHRASE') {
    element = 'Dropdown';
    customType = 'input-select';
  } else if (rm === 'DV_DATE_TIME' || rm === 'DV_DATE' || rm === 'DV_TIME') {
    element = 'DatePicker';
    customType = 'input-text';
  } else if (rm === 'DV_BOOLEAN') {
    element = 'Checkboxes';
    customType = 'input-text';
  }

  const [{ isDragging }, drag] = useDrag({
    type: 'card',
    item: () => ({
      id: 'field_' + Math.random().toString(36).substr(2, 9),
      index: -1,
      data: {
        key: field.fieldName,
        element: element,
        name: field.label,
        label: field.label,
        field_name: field.fieldName + '_',
        custom_metadata: {
          type: customType,
          // The field's full openEHR identity, straight from the parser
          // (see webTemplateParser.ts) - not just path/rmType. Carries
          // archetypeNodeId/archetypeId/rmVersion/templateId through from
          // the moment a field is dropped onto the canvas, matching what
          // formBuilderToCanonical now writes back into node.binding.
          binding: fieldBinding(field),
          unitOptions: (field.constraints?.unitOptions && field.constraints.unitOptions.length > 0)
            ? field.constraints.unitOptions
            : (field.rmType === 'DV_QUANTITY' ? [{ unit: 'cm' }] : undefined),
        }
      },
      onCreate: (data: any) => {
        const isChoice = ['Dropdown', 'Checkboxes', 'RadioButtons', 'Tags'].includes(data.element);
        const isDateTime = field.rmType === 'DV_DATE_TIME';
        const isTime = field.rmType === 'DV_TIME';
        return {
          id: 'field_' + Math.random().toString(36).substr(2, 9),
          element: data.element,
          text: getElementText(data.element, data.label),
          label: data.label,
          field_name: getUniqueFieldName(field.technicalName || field.fieldName),
          custom_metadata: data.custom_metadata,
          required: field.required || false,
          dateFormat: data.element === 'DatePicker' ? 'dd.MM.yyyy' : undefined,
          timeFormat: data.element === 'DatePicker' ? 'HH:mm' : undefined,
          showTimeSelect: isDateTime || isTime ? true : undefined,
          showTimeSelectOnly: isTime ? true : undefined,
          options: isChoice ? ((field.options?.map((opt: any) => ({
            value: opt.value,
            text: opt.text,
            key: opt.key || `opt_${Math.random().toString(36).substr(2, 9)}`
          }))) || [
            { value: 'option_1', text: 'Option 1', key: `opt_${Math.random().toString(36).substr(2, 9)}` },
            { value: 'option_2', text: 'Option 2', key: `opt_${Math.random().toString(36).substr(2, 9)}` }
          ]) : undefined
        };
      }
    }),
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });
  return (
    <div
      ref={drag}
      className={`tree-leaf ${inForm ? 'in-form' : 'unused'}`}
      style={{
        opacity: isDragging ? 0.5 : (inForm ? 0.55 : 1),
        cursor: 'grab',
        padding: '0.45rem 0.6rem',
        borderRadius: '6px',
        border: '1px solid #e2e8f0',
        background: '#ffffff',
        marginBottom: '0.35rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.2rem',
        transition: 'all 0.15s'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.4rem' }}>
        <span style={{ fontWeight: 600, fontSize: '0.82rem', color: '#1e293b', display: 'flex', alignItems: 'center', gap: '0.35rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: inForm ? '#10b981' : '#94a3b8', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center' }}>●</span>
          {field.label}
        </span>
        {field.required && (
          <span style={{
            fontSize: '0.62rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            background: '#fef2f2',
            color: '#ef4444',
            border: '1px solid #fee2e2',
            padding: '0.05rem 0.3rem',
            borderRadius: '4px',
            flexShrink: 0
          }}>
            Required
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.4rem', fontSize: '0.72rem', color: '#64748b' }}>
        <span style={{ fontFamily: 'monospace', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={field.technicalName}>
          {field.technicalName}
        </span>
        <span style={{ fontWeight: 500, fontSize: '0.7rem', color: '#94a3b8', flexShrink: 0 }}>
          {field.rmType}
        </span>
      </div>
    </div>
  );
}

// Draggable folder header to drag entire groups into form canvas
function DraggableFolderHeader({ 
  groupName, 
  repeatableContainers, 
  groupedTree, 
  isExpanded, 
  onClick,
  onSave
}: { 
  groupName: string; 
  repeatableContainers: Record<string, any>; 
  groupedTree: Record<string, any[]>; 
  isExpanded: boolean; 
  onClick: () => void; 
  onSave?: (data: any[]) => void;
}) {
  const [{ isDragging }, drag] = useDrag({
    type: 'card',
    item: () => {
      const containerId = 'container_' + Math.random().toString(36).substr(2, 9);
      const childFields = groupedTree[groupName] || [];
      const parentTechName = childFields[0]?.parentTechnicalName || groupName;
      return {
        id: containerId,
        index: -1,
        data: {
          element: 'FieldSet',
          text: getElementText('FieldSet', groupName),
          label: groupName,
          isContainer: true,
          custom_metadata: {
            repeatable: repeatableContainers[groupName] ? true : false,
            repeatMin: repeatableContainers[groupName]?.repeatMin ?? 0,
            repeatMax: repeatableContainers[groupName]?.repeatMax ?? -1,
            technicalName: parentTechName
          }
        },
        onCreate: (data: any) => {
          const parentId = 'container_' + Math.random().toString(36).substr(2, 9);
          
          setTimeout(() => {
            console.log('DRAG DROP FOLDER:', groupName);
            console.log('DRAG DROP FOLDER: childFields count:', childFields.length);
            console.log('DRAG DROP FOLDER: ElementStore data count:', (ElementStore as any).state?.data?.length);

            const newItems: any[] = [];
            const usedNames = new Set<string>();

            childFields.forEach((field: any) => {
              const childId = 'field_' + Math.random().toString(36).substr(2, 9);
              let childElement = 'TextInput';
              let childCustomType = 'input-text';
              const rm = field.rmType || '';

              if (rm === 'DV_QUANTITY' || rm === 'DV_PROPORTION' || rm === 'DV_COUNT' || rm.includes('INTEGER')) {
                childElement = 'NumberInput';
                childCustomType = rm === 'DV_QUANTITY' ? 'input-quantity' : 'input-proportion';
              } else if (rm === 'DV_CODED_TEXT' || rm === 'DV_ORDINAL' || rm === 'CODE_PHRASE') {
                childElement = 'Dropdown';
                childCustomType = 'input-select';
              } else if (rm === 'DV_DATE_TIME' || rm === 'DV_DATE' || rm === 'DV_TIME') {
                childElement = 'DatePicker';
                childCustomType = 'input-text';
              } else if (rm === 'DV_BOOLEAN') {
                childElement = 'Checkboxes';
                childCustomType = 'input-text';
              }

              const isChoice = ['Dropdown', 'Checkboxes', 'RadioButtons', 'Tags'].includes(childElement);
              const isDateTime = field.rmType === 'DV_DATE_TIME';
              const isTime = field.rmType === 'DV_TIME';

              const childItem = {
                id: childId,
                parentId: parentId,
                element: childElement,
                text: getElementText(childElement, field.label),
                label: field.label,
                field_name: getUniqueFieldName(field.technicalName || field.fieldName, usedNames),
                required: field.required || false,
                dateFormat: childElement === 'DatePicker' ? 'dd.MM.yyyy' : undefined,
                timeFormat: childElement === 'DatePicker' ? 'HH:mm' : undefined,
                showTimeSelect: isDateTime || isTime ? true : undefined,
                showTimeSelectOnly: isTime ? true : undefined,
                custom_metadata: {
                  type: childCustomType,
                  // Same full binding shape as the single-field drag path
                  // (DraggableFieldNode above) - previously this omitted
                  // templateAlias/archetypeNodeId/archetypeId/rmVersion/
                  // templateId that the other path already carried.
                  binding: fieldBinding(field),
                },
                options: isChoice ? ((field.options?.map((opt: any) => ({
                  value: opt.value,
                  text: opt.text,
                  key: opt.key || `opt_${Math.random().toString(36).substr(2, 9)}`
                }))) || [
                  { value: 'option_1', text: 'Option 1', key: `opt_${Math.random().toString(36).substr(2, 9)}` },
                  { value: 'option_2', text: 'Option 2', key: `opt_${Math.random().toString(36).substr(2, 9)}` }
                ]) : undefined
              };

              newItems.push(childItem);
            });

            console.log('DRAG DROP FOLDER: newItems count:', newItems.length);

            if (newItems.length > 0) {
              const childIds = newItems.map(item => item.id);
              const updatedData = (ElementStore as any).state.data.map((item: any) => {
                if (item.id === parentId) {
                  return { ...item, childItems: childIds };
                }
                return item;
              });
              const finalData = [...updatedData, ...newItems];
              (ElementStore as any).dispatch('setData', finalData, true);
              if (onSave) {
                onSave(finalData);
              }
            }
          }, 100);

          return {
            id: parentId,
            element: 'FieldSet',
            text: data.text,
            label: data.label,
            isContainer: true,
            custom_metadata: data.custom_metadata || {},
            childItems: []
          };
        }
      };
    },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    })
  });

  const repeatMeta = repeatableContainers[groupName];

  return (
    <div
      ref={drag}
      className="tree-folder-header"
      onClick={onClick}
      style={{
        opacity: isDragging ? 0.5 : 1,
        cursor: 'grab',
        display: 'flex',
        alignItems: 'center',
        padding: '0.4rem 0.6rem',
        borderRadius: '4px',
        background: '#f8fafc',
        border: isDragging ? '1px dashed #0891b2' : '1px solid #e2e8f0',
        transition: 'all 0.15s ease'
      }}
      onMouseOver={(e) => { if (!isDragging) e.currentTarget.style.background = '#f1f5f9'; }}
      onMouseOut={(e) => { if (!isDragging) e.currentTarget.style.background = '#f8fafc'; }}
    >
      <span style={{ marginRight: '0.5rem', userSelect: 'none' }}>{isExpanded ? '▼' : '▶'}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1 }}>
        📁 <strong>{groupName}</strong>
        {repeatMeta && (
          <span style={{ fontSize: '0.65rem', color: '#0891b2', background: '#ecfeff', padding: '0.1rem 0.35rem', borderRadius: '3px', fontFamily: 'monospace', fontWeight: 600 }}>
            ↻ {repeatMeta.repeatMin}..{repeatMeta.repeatMax === -1 ? '*' : repeatMeta.repeatMax}
          </span>
        )}
      </span>
      <i className="fas fa-grip-vertical" style={{ color: '#94a3b8', fontSize: '0.8rem', cursor: 'grab' }} title="Drag to add entire group"></i>
    </div>
  );
}

// Draggable node for visual/layout items
function DraggableLayoutNode({ item }: { item: any }) {
  const [{ isDragging }, drag] = useDrag({
    type: 'card',
    item: () => ({
      id: 'layout_' + Math.random().toString(36).substr(2, 9),
      index: -1,
      data: item,
      onCreate: (data: any) => {
        const id = 'layout_' + Math.random().toString(36).substr(2, 9);
        return {
          ...data,
          id,
          element: data.element,
          text: getElementText(data.element, data.label || data.name),
          static: data.static || false,
          content: data.content || '',
          label: data.label || '',
          col_count: data.col_count,
          class_name: data.class_name,
          options: data.options || [],
          field_name: data.field_name ? data.field_name + Math.random().toString(36).substr(2, 4) : 'layout_',
          custom_metadata: data.custom_metadata || {}
        };
      }
    }),
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  return (
    <div
      ref={drag}
      className="toolbox-item"
      style={{ opacity: isDragging ? 0.5 : 1 }}
    >
      <i className={item.icon}></i>
      <span>{item.name}</span>
    </div>
  );
}

export default function FormBuilder() {
  return (
    <DesignerShell kind="clinical-form" dragAndDrop>
      <FormBuilderContent />
    </DesignerShell>
  );
}

function FormBuilderContent() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { customFields } = useFrontendPlugins();
  
  React.useMemo(() => {
    customFields.forEach(cf => {
      try {
        FormBuilders.Registry.register(cf.key, cf.component as any);
      } catch (e) {
        // Ignore "already registered" errors during hot-reload or strict mode
      }
    });
  }, [customFields]);

  const [form, setForm] = useState<any>(null);
  const formRef = React.useRef<any>(null);
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  const [templateFields, setTemplateFields] = useState<any[]>([]);
  const [builderItems, setBuilderItems] = useState<any[]>([]);
  const hydratedBuilderItems = React.useMemo(
    () => hydrateCustomBuilderElements(builderItems, customFields),
    [builderItems, customFields],
  );
  const [remoteTemplates, setRemoteTemplates] = useState<any[]>([]);
  const [remoteTemplatesError, setRemoteTemplatesError] = useState<string | null>(null);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  // Populated alongside remoteTemplates purely to look up each remote
  // entry's real, already-parsed semVer by template_id below - EHRbase's
  // template-list endpoint itself never returns a version, only
  // concept/template_id/timestamps, so without this every row showed
  // "Version: unknown" even for templates already imported (and thus
  // already holding a real version locally).
  const [localTemplatesForVersion, setLocalTemplatesForVersion] = useState<any[]>([]);

  // Left panel tabs: 'fields' | 'layout'
  const [leftTab, setLeftTab] = useState<'fields' | 'layout'>('fields');
  // Right panel tabs: 'properties' | 'openehr' | 'json'
  const [rightTab, setRightTab] = useState<'properties' | 'openehr' | 'json'>('properties');
  // Expanded/collapsed state for tree groups
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Right Inspector scope: 'field' | 'form'
  const [inspectorScope, setInspectorScope] = useState<'field' | 'form'>('field');
  // Form settings tabs: 'general' | 'openehr' | 'submission' | 'export'
  const [formTab, setFormTab] = useState<'general' | 'openehr' | 'submission' | 'export' | 'aqlPrefill'>('general');

  // Left panel modes & filters
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRequired, setFilterRequired] = useState(false);
  const [filterUnused, setFilterUnused] = useState(false);
  const [filterInForm, setFilterInForm] = useState(false);
  const [expertMode, setExpertMode] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  // Active element editing state from react-form-builder2
  const [activeEditElement, setActiveEditElement] = useState<any | null>(null);
  // Store the library's updateElement fn (used to propagate changes back into the canvas store)
  const updateElementFnRef = React.useRef<((elem: any) => void) | null>(null);

  // One integrated workbench per form: Designer | Preview | TypeScript | Logs | Live JSON
  const [previewMode, setPreviewMode] = useState<'edit' | 'runtime' | 'typescript' | 'logs' | 'clinical' | 'export' | 'json'>('edit');
  // Warnings Drawer toggle
  const [warningsOpen, setWarningsOpen] = useState(false);

  // Patient context for the Preview tab: without a patientId/ehrId the real
  // FormRuntime it renders has nothing to hand the AQL-prefill plugin (see
  // `form:wrapper` in FormRuntime.tsx -> AqlPrefillProvider), so prefill
  // buttons render but can never resolve data. Mirrors the same
  // patient-picker + config-default pattern already built for Widgets
  // admin's preview panel, so AQL mappings can be tested here without
  // leaving for a real SessionRuntime session.
  const [previewPatients, setPreviewPatients] = useState<Array<{ id: string; patientId: string; patientNamespace?: string; namespace?: string; ehrId?: string | null; firstName?: string; lastName?: string }>>([]);
  // Draft values track the inputs on every keystroke; "applied" is what
  // actually gets handed to FormRuntime (via the key below), and only
  // catches up on blur or on a dropdown pick. Without this split, typing a
  // manual patient-ID/EHR-ID character by character would remount
  // FormRuntime - and re-spin its formScript worker - on every keystroke.
  const [previewPatientId, setPreviewPatientId] = useState('');
  const [previewEhrId, setPreviewEhrId] = useState('');
  const [appliedPreviewPatientId, setAppliedPreviewPatientId] = useState('');
  const [appliedPreviewEhrId, setAppliedPreviewEhrId] = useState('');
  const applyPreviewContext = () => { setAppliedPreviewPatientId(previewPatientId); setAppliedPreviewEhrId(previewEhrId); };
  // Gates the first FormRuntime mount until the default patient/EHR-ID is
  // known. Without this, FormRuntime would mount once with an empty
  // patientId/ehrId, then immediately remount (via the key below) once the
  // default resolves - tearing down the formScript worker mid-init and
  // surfacing a spurious "Form Script Runtime wurde beendet" toast.
  const [previewContextLoaded, setPreviewContextLoaded] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const [patientsRes, defaultsRes] = await Promise.all([
          fetch('http://localhost:3001/api/patients'),
          fetch('http://localhost:3001/api/config/preview-defaults'),
        ]);
        const patients = await patientsRes.json();
        const defaults = await defaultsRes.json();
        setPreviewPatients(Array.isArray(patients) ? patients : []);
        const defaultEhrId = typeof defaults?.defaultEhrId === 'string' ? defaults.defaultEhrId.trim() : '';
        const matched = defaultEhrId && Array.isArray(patients) ? patients.find((item: any) => item.ehrId === defaultEhrId) : undefined;
        const resolvedPatientId = matched ? matched.patientId : '';
        const resolvedEhrId = matched ? (matched.ehrId || '') : defaultEhrId;
        setPreviewPatientId(resolvedPatientId); setPreviewEhrId(resolvedEhrId);
        setAppliedPreviewPatientId(resolvedPatientId); setAppliedPreviewEhrId(resolvedEhrId);
      } catch { /* Preview patient context is a convenience, not required to use the rest of the builder. */ }
      finally { setPreviewContextLoaded(true); }
    })();
  }, []);

  // Repeat instances: maps item.id -> array of instance UUIDs
  const [repeatInstances, setRepeatInstances] = useState<Record<string, string[]>>({});
  // Collapsed repeat instances: maps instanceId -> boolean
  const [collapsedInstances, setCollapsedInstances] = useState<Record<string, boolean>>({});
  // Form field values: maps instanceId/fieldId -> value
  const [fieldValues, setFieldValues] = useState<Record<string, any>>({});
  // Validation errors: maps field path/instanceId -> error string
  const [, setValidationErrors] = useState<Record<string, string>>({});
  const layoutToolboxItems = React.useMemo(() => [
    { key: 'FieldSet', element: 'FieldSet', name: 'Container / Group', icon: 'fas fa-bars', label: 'Group Container' },
    { key: 'TwoColumnRow', element: 'TwoColumnRow', name: '2-Column Row', icon: 'fas fa-columns', label: '' },
    { key: 'ThreeColumnRow', element: 'ThreeColumnRow', name: '3-Column Row', icon: 'fas fa-columns', label: '' },
    { key: 'Header', element: 'Header', name: 'Header / Title', icon: 'fas fa-heading', static: true, content: 'Section Header' },
    { key: 'Paragraph', element: 'Paragraph', name: 'Paragraph / Text', icon: 'fas fa-paragraph', static: true, content: 'Layout text description...' },
    { key: 'Button', element: 'HyperLink', name: 'Action Button', icon: 'fas fa-bolt', label: 'Aktion', field_name: 'action_', custom_metadata: { type: 'button' } },
    { key: 'LineBreak', element: 'LineBreak', name: 'Divider Line', icon: 'fas fa-arrows-alt-h', static: true },
    ...customFields.map(cf => ({
      ...cf.toolboxItem,
      key: cf.key,
      element: 'CustomElement',
      component: cf.component,
      type: 'custom',
      custom: true,
      forwardRef: true
    }))
  ], [customFields]);

  const initializeRepeatInstances = (layout: any) => {
    const initialInstances: Record<string, string[]> = {};
    const initialValues: Record<string, any> = {};

    function traverse(node: any, parentInstanceId: string) {
      if (node.type === 'container') {
        const isRepeat = node.repeatable === true;
        const min = node.repeatMin ?? 0;
        const count = min > 0 ? min : 0;
        const instancesKey = `${parentInstanceId}/${node.id}`;

        if (isRepeat) {
          const ids: string[] = [];
          for (let i = 0; i < count; i++) {
            ids.push(crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substr(2, 12));
          }
          initialInstances[instancesKey] = ids;

          ids.forEach(instId => {
            node.children?.forEach((child: any) => traverse(child, instId));
          });
        } else {
          node.children?.forEach((child: any) => traverse(child, parentInstanceId));
        }
        return;
      }

      // Leaf field
      if (node.repeatable === true) {
        const min = node.repeatMin ?? 0;
        const count = min > 0 ? min : 0;
        const instancesKey = `${parentInstanceId}/${node.id}`;

        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          ids.push(crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substr(2, 12));
        }
        initialInstances[instancesKey] = ids;
      }
    }

    const rootContainer = layout.children?.[0];
    if (rootContainer && rootContainer.children) {
      rootContainer.children.forEach((child: any) => traverse(child, 'root'));
    }

    setRepeatInstances(initialInstances);
    setFieldValues(initialValues);
    setValidationErrors({});
    setCollapsedInstances({});
  };

  const findLayoutNode = (node: any, nodeId: string): any | null => {
    if (node.id === nodeId) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = findLayoutNode(child, nodeId);
        if (found) return found;
      }
    }
    return null;
  };

  const getInstances = (itemId: string, meta: any): string[] => {
    void meta;
    return repeatInstances[itemId] || [];
  };

  const addInstance = (repeatKey: string, meta: any) => {
    const parts = repeatKey.split('/');
    const nodeId = parts[parts.length - 1];
    const newId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substr(2, 12);

    setRepeatInstances(prev => {
      const current = prev[repeatKey] || [];
      const max = meta?.repeatMax ?? -1;
      if (max !== -1 && current.length >= max) return prev;

      const nextState = { ...prev, [repeatKey]: [...current, newId] };

      if (form?.canonical_json?.layout) {
        const node = findLayoutNode(form.canonical_json.layout, nodeId);
        if (node && node.children) {
          node.children.forEach((child: any) => {
            const traverse = (n: any, parentInstId: string) => {
              if (n.type === 'container') {
                const isRepeat = n.repeatable === true;
                const min = n.repeatMin ?? 0;
                const count = min > 0 ? min : 0;
                const childKey = `${parentInstId}/${n.id}`;

                if (isRepeat) {
                  const ids: string[] = [];
                  for (let i = 0; i < count; i++) {
                    ids.push(crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substr(2, 12));
                  }
                  nextState[childKey] = ids;
                  ids.forEach(instId => {
                    n.children?.forEach((c: any) => traverse(c, instId));
                  });
                } else {
                  n.children?.forEach((c: any) => traverse(c, parentInstId));
                }
                return;
              }

              if (n.repeatable === true) {
                const min = n.repeatMin ?? 0;
                const count = min > 0 ? min : 0;
                const childKey = `${parentInstId}/${n.id}`;
                const ids: string[] = [];
                for (let i = 0; i < count; i++) {
                  ids.push(crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substr(2, 12));
                }
                nextState[childKey] = ids;
              }
            };
            traverse(child, newId);
          });
        }
      }

      return nextState;
    });
  };

  const removeInstance = (repeatKey: string, instanceId: string, meta: any) => {
    setRepeatInstances(prev => {
      const current = prev[repeatKey] || [];
      const min = meta?.repeatMin ?? 0;
      if (current.length <= min) return prev;
      return { ...prev, [repeatKey]: current.filter(id => id !== instanceId) };
    });
  };

  const toggleCollapse = (instanceId: string) => {
    setCollapsedInstances(prev => ({ ...prev, [instanceId]: !prev[instanceId] }));
  };

  const validationErrorsList = React.useMemo(() => {
    if (!form?.canonical_json) return {};
    const errors: Record<string, string> = {};
    const rootContainer = form.canonical_json.layout.children?.[0];
    if (rootContainer) {
      validateForm(rootContainer, 'root', repeatInstances, fieldValues, errors);
    }
    return errors;
  }, [form, repeatInstances, fieldValues]);

  const openEhrFlatJson = React.useMemo(() => {
    if (!form?.canonical_json) return {};
    try {
      return exportToOpenEhrFlatJson(form.canonical_json, repeatInstances, fieldValues);
    } catch (e) {
      return { error: 'Failed to serialize: ' + (e as any).message };
    }
  }, [form, repeatInstances, fieldValues]);

  const repeatableContainers = React.useMemo(() => {
    const repeatable: Record<string, { repeatMin: number; repeatMax: number }> = {};
    if (!form?.canonical_json?.layout) return repeatable;

    function traverse(node: any) {
      if (node.type === 'container') {
        if (node.repeatable) {
          repeatable[node.label] = {
            repeatMin: node.repeatMin ?? 0,
            repeatMax: node.repeatMax ?? -1
          };
        }
        node.children?.forEach(traverse);
      }
    }

    traverse(form.canonical_json.layout);
    return repeatable;
  }, [form]);

  const updateFormGeneral = (key: string, value: any) => {
    if (!formRef.current) return;
    const updatedForm = { ...formRef.current };
    if (['name', 'version', 'status'].includes(key)) {
      updatedForm[key] = value;
      updatedForm.canonical_json = {
        ...updatedForm.canonical_json,
        [key]: value
      };
    } else {
      updatedForm.canonical_json = {
        ...updatedForm.canonical_json,
        settings: {
          ...(updatedForm.canonical_json.settings || {}),
          [key]: value
        }
      };
    }
    formRef.current = updatedForm;
    setForm(updatedForm);
  };

  const updateRuntimeSetting = (key: string, value: any) => {
    if (!formRef.current) return;
    const updatedForm = { ...formRef.current };
    updatedForm.canonical_json = {
      ...updatedForm.canonical_json,
      settings: {
        ...(updatedForm.canonical_json.settings || {}),
        runtime: {
          ...(updatedForm.canonical_json.settings?.runtime || {}),
          [key]: value
        }
      }
    };
    formRef.current = updatedForm;
    setForm(updatedForm);
  };


  const fetchForm = () => {
    fetch(`http://localhost:3001/api/forms/${id}`)
      .then(res => res.json())
      .then(data => {
        setForm(data);
        const items = canonicalToFormBuilder(data.canonical_json);
        setBuilderItems(items);
        initializeRepeatInstances(data.canonical_json);

        const sourceTemplate = data.canonical_json.sourceTemplates?.[0];
        if (sourceTemplate) {
          fetch(`http://localhost:3001/api/templates`)
            .then(res => res.json())
            .then(templates => {
              const matched = templates.find((t: any) => t.template_id === sourceTemplate.id);
              if (matched) {
                fetch(`http://localhost:3001/api/templates/${matched.id}/fields`)
                  .then(res => res.json())
                  .then(fields => {
                    setTemplateFields(fields);
                    // Automatically expand all tree folders by default
                    const groups = groupFieldsByParent(fields);
                    const initialExpanded: Record<string, boolean> = {};
                    Object.keys(groups).forEach(k => { initialExpanded[k] = true; });
                    setExpandedGroups(initialExpanded);
                  });
              }
            });
        }
      });
  };

  useEffect(() => {
    fetchForm();
    fetch('http://localhost:3001/api/templates/remote')
      .then(res => {
        if (!res.ok) {
          throw new Error(`Server responded with status ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setRemoteTemplates(data);
          setRemoteTemplatesError(null);
        } else {
          setRemoteTemplates([]);
          setRemoteTemplatesError("Invalid data format received from server.");
        }
      })
      .catch((err) => {
        setRemoteTemplates([]);
        setRemoteTemplatesError(err.message || "Failed to connect to the server.");
      });
    fetch('http://localhost:3001/api/templates')
      .then(res => res.json())
      .then(data => setLocalTemplatesForVersion(Array.isArray(data) ? data : []))
      .catch(() => setLocalTemplatesForVersion([]));
  }, [id]);

  useEffect(() => {
    // 1. Intercept dragstart events to restrict dragging to ONLY the grip handle button.
    // We track the clicked target in mousedown/touchstart because the dragstart target is
    // the draggable wrapper container itself (which always contains the grip handle).
    let wasLastClickOnDragHandle = false;

    const checkDragHandle = (target: HTMLElement) => {
      wasLastClickOnDragHandle =
        target.classList.contains('fa-grip-vertical') ||
        target.classList.contains('fa-arrows-alt') ||
        target.closest('.fa-grip-vertical') !== null ||
        target.closest('.fa-arrows-alt') !== null ||
        target.closest('.drag-handle') !== null ||
        (target.classList.contains('btn') && target.innerHTML.includes('fa-grip-vertical'));
    };

    const handleMouseDown = (e: MouseEvent) => {
      checkDragHandle(e.target as HTMLElement);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        checkDragHandle(e.touches[0].target as HTMLElement);
      }
    };

    const handleDragStart = (e: DragEvent) => {
      const target = e.target as HTMLElement;
      // If we are inside a preview container and the drag was not initiated from a drag handle click, cancel it!
      if (target.closest('.react-form-builder-preview') && !wasLastClickOnDragHandle) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      (window as any).isCurrentlyDragging = true;
    };

    const handleDragEnd = () => {
      (window as any).isCurrentlyDragging = false;
    };

    window.addEventListener('mousedown', handleMouseDown, true);
    window.addEventListener('touchstart', handleTouchStart, true);
    window.addEventListener('dragstart', handleDragStart, true);
    window.addEventListener('dragend', handleDragEnd, true);
    window.addEventListener('drop', handleDragEnd, true);
    window.addEventListener('mouseup', handleDragEnd, true);
    window.addEventListener('touchend', handleDragEnd, true);

    // 2. Scan DOM to tag FieldSet (Group Container) cards with a helper class for CSS styling.
    // This runs periodically when builder items list changes.
    const timer = setTimeout(() => {
      const rfbItems = document.querySelectorAll('.react-form-builder-preview .rfb-item');
      rfbItems.forEach(item => {
        const innerRow = item.querySelector('.row');
        // If a row contains col-md-12, it is a FieldSet (Group Container)
        if (innerRow && innerRow.querySelector('.col-md-12')) {
          item.classList.add('group-fieldset-container');
        }
      });
    }, 150);

    return () => {
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('touchstart', handleTouchStart, true);
      window.removeEventListener('dragstart', handleDragStart, true);
      window.removeEventListener('dragend', handleDragEnd, true);
      window.removeEventListener('drop', handleDragEnd, true);
      window.removeEventListener('mouseup', handleDragEnd, true);
      window.removeEventListener('touchend', handleDragEnd, true);
      clearTimeout(timer);
    };
  }, [builderItems]);



  const handleSave = (postData: any) => {
    if (!formRef.current) return;
    let items = Array.isArray(postData) ? postData : (postData?.task_data || builderItems);
    
    let changed = false;
    items.forEach((item: any) => {
      // 1. Maintain the "Type: Name" prefix format in item.text (shown on canvas badges)
      // while keeping item.label clean (used for Cambio export & locales)
      const cleanLabelVal = item.label || item.text || '';
      const targetText = getElementText(item.element, cleanLabelVal);
      if (item.text !== targetText) {
        item.text = targetText;
        changed = true;
      }

      // 2. Clean up FieldSet childItems to ensure only one trailing null (dropzone) is present
      if (item.element === 'FieldSet' && Array.isArray(item.childItems)) {
        const activeChildren = item.childItems.filter((x: any) => x !== null && x !== undefined);
        const targetChildItems = [...activeChildren, null];
        const isDifferent = item.childItems.length !== targetChildItems.length ||
                            item.childItems.some((x: any, idx: number) => x !== targetChildItems[idx]);
        if (isDifferent) {
          item.childItems = targetChildItems;
          changed = true;
        }
      }
    });

    if (changed && !(window as any).isCurrentlyDragging) {
      // Dispatch setData back to the store so the canvas UI remains perfectly in sync.
      // We pass false to prevent triggers that would loop back into handleSave.
      (ElementStore as any).dispatch('setData', [...items], false);
    }

    // Update local state immediately so stats, validations, and previews are fully live
    setBuilderItems(items);

    const updatedCanonical = formBuilderToCanonical(items, formRef.current.canonical_json);

    fetch(`http://localhost:3001/api/forms/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedCanonical)
    })
      .then(res => res.json())
      .then(data => {
        setForm(data);
      })
      .catch(err => console.error("Autosave failed:", err));
  };

  const downloadJson = (jsonObj: any, filename: string) => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(jsonObj, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", filename);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const selectTemplate = (templateId: string) => {
    setLoadingTemplate(true);
    fetch(`http://localhost:3001/api/templates/remote/${encodeURIComponent(templateId)}/import`, { method: 'POST' })
      .then(res => res.json())
      .then(importData => {
        if (importData.template) {
          fetch(`http://localhost:3001/api/forms/${id}/apply-template`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ templateId: importData.template.id })
          })
            .then(() => {
              setLoadingTemplate(false);
              fetchForm();
            });
        }
      })
      .catch(() => {
        setLoadingTemplate(false);
        alert('Failed to load template from EHRbase.');
      });
  };

  // Group fields by parent Observation / Section from their parentName
  const groupFieldsByParent = (fields: any[]) => {
    const groups: Record<string, any[]> = {};
    fields.forEach(field => {
      if (!expertMode && isContextField(field)) {
        return;
      }
      // Hide fields that are already placed in the form if they are restricted to at most one occurrence
      const inForm = builderItems.some(i => i.field_name?.startsWith(field.fieldName));
      if (field.maxOccurrences === 1 && inForm) {
        return;
      }

      const parentName = field.parentName || 'Other';
      if (!groups[parentName]) {
        groups[parentName] = [];
      }
      groups[parentName].push(field);
    });
    return groups;
  };

  if (!form) return <p>Loading Form Builder...</p>;

  // FORCE TEMPLATE SELECTION IF EMPTY
  if (!form.canonical_json.sourceTemplates || form.canonical_json.sourceTemplates.length === 0) {
    return (
      <div style={{ maxWidth: '800px', margin: '2rem auto', height: 'calc(100vh - 4rem)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.75rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>Select a WebTemplate from EHRbase</h2>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Before you can build the form "{form.name}", you must select a base template.</p>
        </div>

        {loadingTemplate ? (
          <div className="card" style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
            <p style={{ color: 'var(--primary)', fontWeight: 500 }}>Importing template and generating form layout... Please wait.</p>
          </div>
        ) : (
          <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
            <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--bg-sidebar)' }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>Available Templates</h3>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 1.5rem 1.5rem 1.5rem' }}>
              {remoteTemplatesError ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: '#dc2626' }}>
                  <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Error loading templates</p>
                  <p>{remoteTemplatesError}</p>
                </div>
              ) : remoteTemplates.length === 0 ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>No templates found in EHRbase or failed to connect.</div>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {remoteTemplates.map((t: any) => {
                    // EHRbase's template-list endpoint never returns a
                    // version - only a real import (which parses the full
                    // WebTemplate) discovers one. Show the real, already-
                    // imported version when we have it locally instead of
                    // always claiming "unknown".
                    const localMatch = localTemplatesForVersion.find((lt: any) => lt.template_id === t.template_id);
                    return (
                    <li key={t.template_id} style={{ padding: '1.25rem 0', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', transition: 'background-color 0.2s', borderRadius: '8px' }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.02)'}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <div style={{ paddingLeft: '0.5rem' }}>
                        <strong style={{ fontSize: '1.05rem', display: 'block', marginBottom: '0.25rem', color: 'var(--text-main)' }}>{t.concept || t.template_id}</strong>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', gap: '0.75rem' }}>
                          <span>ID: <span style={{ fontFamily: 'monospace' }}>{t.template_id}</span></span>
                          <span>•</span>
                          <span>Version: {localMatch ? localMatch.version : 'wird beim Import ermittelt'}</span>
                          {localMatch && <span style={{ color: '#16a34a', fontWeight: 600 }}>✓ Bereits importiert</span>}
                        </div>
                      </div>
                      <div style={{ paddingRight: '0.5rem' }}>
                        <button className="btn" onClick={() => selectTemplate(t.template_id)}>
                          Use Template
                        </button>
                      </div>
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Intercept react-form-builder2 properties panel and redirect to our Right Sidebar
  const customRenderEditForm = (editProps: any) => {
    // Always keep the ref fresh (no stale closure)
    updateElementFnRef.current = editProps.updateElement;
    if (activeEditElement?.id !== editProps.element?.id) {
      // Defer state updates to run after render phase completes
      setTimeout(() => {
        setActiveEditElement(editProps.element);
        setRightTab('properties');
        setInspectorScope('field');
      }, 0);
    }
    return null;
  };


  function isContextField(field: any): boolean {
    if (!field) return false;
    if (field.inContext === true) return true;

    const id = (field.technicalName || field.id || field.fieldName || '').toLowerCase();
    const aqlPath = (field.openehrPath || field.aqlPath || '').toLowerCase();
    const flatPath = (field.flatPath || '').toLowerCase();

    const pathSegments = aqlPath.split('/').filter(Boolean);
    const lastSegment = pathSegments[pathSegments.length - 1] || '';
    const cleanLastSegment = lastSegment.split('[')[0].toLowerCase();

    const contextKeys = [
      'language', 'encoding', 'territory', 'composer', 
      'subject', 'category', 'setting', 'start_time', 'context'
    ];

    if (contextKeys.some(k => id === k || id.endsWith('_' + k) || cleanLastSegment === k)) {
      return true;
    }

    for (const key of contextKeys) {
      if (
        aqlPath.endsWith('/' + key) || 
        aqlPath.includes('/' + key + '/') || 
        aqlPath.includes('/' + key + '[') ||
        flatPath.endsWith('/' + key) ||
        flatPath.includes('/' + key + '/')
      ) {
        return true;
      }
    }

    return false;
  };

  const getFilteredFields = () => {
    return templateFields.filter(field => {
      // Hide openEHR RM context fields unless expert mode is active
      if (!expertMode && isContextField(field)) {
        return false;
      }

      // 1. Search Query
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesLabel = field.label?.toLowerCase().includes(query);
        const matchesName = field.fieldName?.toLowerCase().includes(query);
        const matchesPath = field.openehrPath?.toLowerCase().includes(query);
        if (!matchesLabel && !matchesName && !matchesPath) {
          return false;
        }
      }

      // Check if it is currently in form
      const inForm = builderItems.some(i => i.field_name?.startsWith(field.fieldName));

      // 2. Required Only
      if (filterRequired && !field.required) {
        return false;
      }

      // 3. Unused Only
      if (filterUnused && inForm) {
        return false;
      }

      // 5. In Form
      if (filterInForm && !inForm) {
        return false;
      }

      return true;
    });
  };

  const filteredFields = getFilteredFields();
  const groupedTree = groupFieldsByParent(filteredFields);

  // Statistics Calculations
  const totalFields = templateFields.length;
  const fieldsInForm = templateFields.filter(f => builderItems.some(i => i.field_name?.startsWith(f.fieldName))).length;

  // Validation Engine
  const warnings: string[] = [];

  const isFormValid = warnings.length === 0;

  const templateId = form.canonical_json.sourceTemplates?.[0]?.id || '';

  const showTechnicalPaths = form.canonical_json.settings?.showTechnicalPaths ?? true;
  const showStructuralNodes = form.canonical_json.settings?.showStructuralNodes ?? true;

  return (
    <div className={`workbench-container ${!showTechnicalPaths ? 'hide-technical-paths' : ''} ${!showStructuralNodes ? 'hide-structural-nodes' : ''}`}>
      {/* Header — two-line info hierarchy */}
      <header className="workbench-header">
        <div className="workbench-title-area">
          <div className="workbench-title-row">
            <h2>{form.name}</h2>
            <span className={`workbench-badge ${isFormValid ? 'valid' : 'draft'}`}>
              {isFormValid ? '✓ Valid' : 'Draft'}
            </span>
          </div>
          <div className="workbench-meta-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b' }}>v{form.version}</span>
            <span className="workbench-meta-sep">·</span>
            <div className="workbench-template-badge" title={templateId}>
              <span className="badge-title">Template:</span>
              <span className="badge-name">{templateId}</span>
              <span className="badge-stat">{totalFields} fields</span>
              <span className="badge-stat">{fieldsInForm} in form</span>
            </div>
          </div>
        </div>
        <div className="workbench-actions-area">
          <ExtensionSlot name="designer:toolbar" context={{ documentId: String(id || ''), kind: 'clinical-form' }} />
          <nav className="workbench-view-tabs" aria-label="Formular-Arbeitsbereich">
            <button type="button" className={`btn-workbench secondary ${previewMode === 'edit' ? 'active' : ''}`} onClick={() => setPreviewMode('edit')}>Designer</button>
            <button type="button" className={`btn-workbench secondary ${previewMode === 'json' ? 'active' : ''}`} onClick={() => setPreviewMode('json')}>Live JSON</button>
            <button type="button" className={`btn-workbench secondary ${previewMode === 'runtime' ? 'active' : ''}`} onClick={() => setPreviewMode('runtime')}>Preview</button>
            <button type="button" className={`btn-workbench secondary ${previewMode === 'typescript' ? 'active' : ''}`} onClick={() => setPreviewMode('typescript')}>TypeScript</button>
            <button type="button" className={`btn-workbench secondary ${previewMode === 'logs' ? 'active' : ''}`} onClick={() => setPreviewMode('logs')}>Logs</button>
          </nav>
          <button
            className="btn-workbench success"
            onClick={() => handleSave({ task_data: builderItems })}
          >
            💾 Save Draft
          </button>
          <button
            className="btn-workbench secondary"
            onClick={() => navigate(`/forms/${id}/export`)}
          >
            Export ↗
          </button>
        </div>
      </header>

      {/* Main Panels Area */}
      <div className="workbench-panels">
        {previewMode === 'typescript' ? (
          <div className="workbench-scripting-view">
            <ScriptEditor
              formId={String(id)}
              definition={form.canonical_json}
              onSaved={(record) => {
                setForm(record);
                formRef.current = record;
              }}
            />
          </div>
        ) : previewMode === 'logs' ? (
          <div className="workbench-scripting-view">
            <ScriptLogs formId={String(id)} />
          </div>
        ) : previewMode === 'runtime' ? (
          <div className="workbench-runtime-view">
            <div style={{ maxWidth: '960px', margin: '0 auto 1rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '0.85rem 1.1rem', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '0.9rem' }}>
              <label style={{ fontSize: '0.8rem', color: '#475569', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                Test-Patient (für AQL-Vorbelegung)
                <select
                  className="form-input"
                  style={{ minWidth: '260px' }}
                  value={previewPatients.find((item) => item.patientId === previewPatientId)?.id || ''}
                  onChange={(event) => {
                    const selected = previewPatients.find((item) => item.id === event.target.value);
                    const nextPatientId = selected?.patientId || '';
                    const nextEhrId = selected?.ehrId || '';
                    setPreviewPatientId(nextPatientId);
                    setPreviewEhrId(nextEhrId);
                    setAppliedPreviewPatientId(nextPatientId);
                    setAppliedPreviewEhrId(nextEhrId);
                  }}
                >
                  <option value="">— kein Patient —</option>
                  {previewPatients.map((item) => (
                    <option key={item.id} value={item.id}>{[item.lastName, item.firstName].filter(Boolean).join(', ') || item.patientId} · {item.patientId}</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '0.8rem', color: '#475569', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                oder Patient-ID manuell
                <input className="form-input" value={previewPatientId} onChange={(event) => setPreviewPatientId(event.target.value)} onBlur={applyPreviewContext} onKeyDown={(event) => { if (event.key === 'Enter') applyPreviewContext(); }} placeholder="z. B. patient-123" style={{ minWidth: '200px' }} />
              </label>
              <label style={{ fontSize: '0.8rem', color: '#475569', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                EHR-ID (Override)
                <input className="form-input" value={previewEhrId} onChange={(event) => setPreviewEhrId(event.target.value)} onBlur={applyPreviewContext} onKeyDown={(event) => { if (event.key === 'Enter') applyPreviewContext(); }} placeholder="nur falls kein lokaler Patient" style={{ minWidth: '220px' }} />
              </label>
              {!appliedPreviewPatientId && !appliedPreviewEhrId && (
                <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>Ohne Patient läuft die Vorschau, aber AQL-Vorbelegung findet keine Daten.</span>
              )}
            </div>
            {previewContextLoaded ? (
              <FormRuntime
                key={`${appliedPreviewPatientId}::${appliedPreviewEhrId}`}
                definition={form.canonical_json}
                mode="preview"
                submitLabel="Lifecycle testen"
                patientId={appliedPreviewPatientId || undefined}
                ehrId={appliedPreviewEhrId || undefined}
              />
            ) : (
              <div style={{ maxWidth: '960px', margin: '0 auto', color: '#64748b' }}>Patientenkontext wird geladen…</div>
            )}
          </div>
        ) : previewMode === 'json' ? (
          <div className="workbench-scripting-view">
            <LiveJsonEditor 
              form={form} 
              onSave={(newForm, newBuilderItems) => {
                 setForm(newForm);
                 formRef.current = newForm;
                 setBuilderItems(newBuilderItems);
                 (ElementStore as any).dispatch('setData', [...newBuilderItems], false);
              }}
            />
          </div>
        ) : previewMode === 'edit' ? (
          <>
            {/* Left Panel: Tabs for openEHR Tree & Layout Elements */}
            <div className="workbench-panel left">
              <div className="panel-tabs">
                <button className={`panel-tab ${leftTab === 'fields' ? 'active' : ''}`} onClick={() => setLeftTab('fields')}>
                  Template Fields
                </button>
                <button className={`panel-tab ${leftTab === 'layout' ? 'active' : ''}`} onClick={() => setLeftTab('layout')}>
                  Layout Elements
                </button>
              </div>

              <div className="panel-content">
                {leftTab === 'fields' ? (
                  <div className="fields-panel-layout" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                    {/* Search & Filters Block */}
                    <div className="tree-filters-box">
                      <div className="search-row" style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                        <div className="search-wrapper" style={{ flex: 1 }}>
                          <input
                            type="text"
                            placeholder="🔍 Search template fields..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="search-input"
                          />
                        </div>
                        <div className="filter-dropdown-wrapper" style={{ position: 'relative' }}>
                          <button
                            type="button"
                            className={`btn-filter-toggle ${filterRequired || filterUnused || filterInForm ? 'active' : ''}`}
                            onClick={() => setFilterMenuOpen(!filterMenuOpen)}
                            style={{
                              padding: '0.45rem 0.65rem',
                              fontSize: '0.78rem',
                              fontWeight: 600,
                              borderRadius: '6px',
                              border: '1px solid #cbd5e1',
                              background: '#f8fafc',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '0.3rem',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            <i className="fas fa-filter" style={{ fontSize: '0.72rem' }}></i>
                            Filters
                            {(filterRequired || filterUnused || filterInForm) && (
                              <span style={{
                                background: '#3b82f6',
                                color: 'white',
                                fontSize: '0.62rem',
                                padding: '0.05rem 0.25rem',
                                borderRadius: '999px',
                                fontWeight: 700
                              }}>
                                {[filterRequired, filterUnused, filterInForm].filter(Boolean).length}
                              </span>
                            )}
                          </button>
                          {filterMenuOpen && (
                            <div className="filter-menu-popover" style={{
                              position: 'absolute',
                              top: '115%',
                              right: 0,
                              zIndex: 1000,
                              background: 'white',
                              border: '1px solid #cbd5e1',
                              borderRadius: '8px',
                              padding: '0.65rem 0.75rem',
                              boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '0.45rem',
                              minWidth: '140px'
                            }}>
                              <label className="filter-option" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: 0, cursor: 'pointer', fontSize: '0.76rem', color: '#334155', fontWeight: 500 }}>
                                <input type="checkbox" checked={filterRequired} onChange={(e) => setFilterRequired(e.target.checked)} />
                                <span>Required</span>
                              </label>
                              <label className="filter-option" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: 0, cursor: 'pointer', fontSize: '0.76rem', color: '#334155', fontWeight: 500 }}>
                                <input type="checkbox" checked={filterUnused} onChange={(e) => setFilterUnused(e.target.checked)} />
                                <span>Unused</span>
                              </label>
                              <label className="filter-option" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: 0, cursor: 'pointer', fontSize: '0.76rem', color: '#334155', fontWeight: 500 }}>
                                <input type="checkbox" checked={filterInForm} onChange={(e) => setFilterInForm(e.target.checked)} />
                                <span>In form</span>
                              </label>
                              <div style={{ height: '1px', background: '#e2e8f0', margin: '0.2rem 0' }} />
                              <label className="filter-option" style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: 0, cursor: 'pointer', fontSize: '0.76rem', color: '#0f172a', fontWeight: 600 }}>
                                <input type="checkbox" checked={expertMode} onChange={(e) => setExpertMode(e.target.checked)} />
                                <span>⚙️ Expertenmodus</span>
                              </label>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="tree-container" style={{ flex: 1, overflowY: 'auto' }}>
                      {Object.keys(groupedTree).length === 0 ? (
                        <div className="no-fields-matched">No fields match selected filters.</div>
                      ) : (
                        Object.keys(groupedTree).map(groupName => {
                          const isExpanded = expandedGroups[groupName] ?? true;
                          const repeatMeta = repeatableContainers[groupName];
                          return (
                            <div 
                              key={groupName} 
                              className="tree-folder" 
                              style={{ 
                                borderLeft: repeatMeta ? '3px solid #0891b2' : 'none', 
                                paddingLeft: repeatMeta ? '4px' : '0' 
                              }}
                            >
                              <DraggableFolderHeader
                                groupName={groupName}
                                repeatableContainers={repeatableContainers}
                                groupedTree={groupedTree}
                                isExpanded={isExpanded}
                                onClick={() => setExpandedGroups({ ...expandedGroups, [groupName]: !isExpanded })}
                                onSave={handleSave}
                              />
                              {isExpanded && (
                                <div className="tree-folder-children">
                                  {groupedTree[groupName].map((field, idx) => {
                                    const inForm = builderItems.some(i => i.field_name?.startsWith(field.fieldName));
                                    return (
                                      <DraggableFieldNode
                                        key={`${field.fieldName}_${idx}`}
                                        field={field}
                                        inForm={inForm}
                                      />
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="layout-toolbox">
                    <div className="toolbox-group-title">Structure & Layout</div>
                    {layoutToolboxItems.map(item => (
                      <DraggableLayoutNode key={item.key} item={item} />
                    ))}
                  </div>
                )}
              </div>
              <ExtensionSlot name="designer:toolbox" context={{ documentId: String(id || ''), kind: 'clinical-form', activeTab: leftTab }} />
            </div>

            {/* Center Panel: Form Canvas */}
            <div className="workbench-panel center">
              <div className="canvas-scroll-container">
                {/* Form-sheet header */}
                <div className="canvas-form-header">
                  <div className="canvas-form-title">{form.name}</div>
                  <div className="canvas-form-meta">
                    <span>{templateId}</span>
                    {fieldsInForm > 0 && (
                      <><span className="workbench-meta-sep">·</span><span>{fieldsInForm} fields placed</span></>
                    )}
                  </div>
                </div>
                {(() => {
                  const sanitizedLayout = (() => {
                    let layoutData = form.canonical_json?.layout || [];
                    if (typeof layoutData === 'string') {
                      try {
                        layoutData = JSON.parse(layoutData);
                      } catch (e) {
                        layoutData = [];
                      }
                    }
                    if (!Array.isArray(layoutData)) {
                      layoutData = [];
                    }
                    return layoutData.map((item: any) => {
                      if (item.element === 'IframeField') {
                        return { ...item, element: 'CustomElement', type: 'custom', custom: true };
                      }
                      return item;
                    });
                  })();

                  const UnsafeReactFormBuilder = ReactFormBuilder as unknown as React.ComponentType<Record<string, unknown>>;
                  return (
                    <UnsafeReactFormBuilder
                      key={`builder:${customFields.map((field) => field.key).sort().join('|')}`}
                      data={sanitizedLayout}
                      onPost={handleSave}
                      onLoad={async () => hydratedBuilderItems}
                      saveAlways={true}
                      hideToolbar={true}
                      wrapDnd={false}
                      renderEditForm={customRenderEditForm}
                      files={[]}
                    />
                  );
                })()}
                <ExtensionSlot name="designer:canvas" context={{ documentId: String(id || ''), kind: 'clinical-form', activeElementId: activeEditElement?.id || null }} />
              </div>
            </div>

            {/* Right Panel: Scoped Inspector */}
            <div className="workbench-panel right">
              {/* Scope Header Toggle */}
              <div className="inspector-scope-header">
                <button 
                  className={`scope-tab ${inspectorScope === 'field' ? 'active' : ''}`}
                  onClick={() => setInspectorScope('field')}
                >
                  Field Config
                </button>
                <button 
                  className={`scope-tab ${inspectorScope === 'form' ? 'active' : ''}`}
                  onClick={() => setInspectorScope('form')}
                >
                  Form Settings
                </button>
              </div>
              <PluginHost slot="designer" title="Plugin Designer" context={{ formId: id, form: form.canonical_json, data: form.canonical_json }} />
              <ExtensionSlot name="designer:inspector" context={{ documentId: String(id || ''), kind: 'clinical-form', activeElementId: activeEditElement?.id || null, scope: inspectorScope }} />

              {inspectorScope === 'field' ? (
                <>
                  <div className="panel-tabs">
                    <button className={`panel-tab ${rightTab === 'properties' ? 'active' : ''}`} onClick={() => setRightTab('properties')}>
                      Properties
                    </button>
                    <button className={`panel-tab ${rightTab === 'openehr' ? 'active' : ''}`} onClick={() => setRightTab('openehr')}>
                      openEHR
                    </button>
                    <button className={`panel-tab ${rightTab === 'json' ? 'active' : ''}`} onClick={() => setRightTab('json')}>
                      JSON
                    </button>
                  </div>

                  <div className="panel-content">
                    {activeEditElement ? (
                      <div className="inspector-tab-content">
                        {/* Element name at top */}
                        <div className="inspector-element-name" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontStyle: 'italic', color: '#64748b', fontWeight: 500, fontSize: '0.78rem' }}>
                            <i className={(() => {
                              const el = activeEditElement.element;
                              if (el === 'FieldSet') return 'fas fa-folder';
                              if (el === 'TextInput') return 'fas fa-font';
                              if (el === 'NumberInput') return 'fas fa-hashtag';
                              if (el === 'Dropdown') return 'fas fa-chevron-down';
                              if (el === 'DatePicker') return 'fas fa-calendar-alt';
                              if (el === 'Checkboxes') return 'fas fa-check-square';
                              if (el === 'RadioButtons') return 'fas fa-dot-circle';
                              if (el === 'TextArea') return 'fas fa-align-left';
                              if (el === 'Paragraph') return 'fas fa-paragraph';
                              if (el === 'Header') return 'fas fa-heading';
                              if (el === 'LineBreak') return 'fas fa-arrows-alt-h';
                              if (el === 'Button') return 'fas fa-bolt';
                              if (el?.includes?.('Column')) return 'fas fa-columns';
                              return 'fas fa-cog';
                            })()} style={{ fontSize: '0.75rem' }}></i>
                            {(() => {
                              const el = activeEditElement.element;
                              if (el === 'FieldSet') return 'Group';
                              if (el === 'TextInput') return 'Text';
                              if (el === 'NumberInput') return 'Number';
                              if (el === 'Dropdown') return 'Select';
                              if (el === 'DatePicker') return 'Date';
                              if (el === 'Checkboxes') return 'Checkbox';
                              if (el === 'RadioButtons') return 'Radio';
                              if (el === 'TextArea') return 'Textarea';
                              if (el === 'Paragraph') return 'Paragraph';
                              if (el === 'Header') return 'Header';
                              if (el === 'LineBreak') return 'Divider';
                              if (el === 'Button') return 'Button';
                              if (el?.includes?.('Column')) return 'Layout';
                              return el || '';
                            })()}:
                          </span>
                          <span style={{ fontWeight: 700 }}>
                            {(() => {
                              const raw = activeEditElement.label || activeEditElement.text || activeEditElement.element || '';
                              const match = raw.match(/^(Group|Text|Number|Select|Date|Checkbox|Radio|Textarea|Paragraph|Header|Layout|Divider):\s*(.*)$/);
                              return match ? match[2] : raw;
                            })()}
                          </span>
                          {activeEditElement.custom_metadata?.binding && (
                            <span style={{ fontSize: '0.65rem', color: '#7c3aed', background: '#f5f3ff', padding: '0.1rem 0.35rem', borderRadius: '3px', fontFamily: 'monospace', fontWeight: 600 }}>
                              {activeEditElement.custom_metadata.binding.rmType}
                            </span>
                          )}
                          {activeEditElement.custom_metadata?.repeatable && (
                            <span style={{ fontSize: '0.65rem', color: '#0891b2', background: '#ecfeff', padding: '0.1rem 0.35rem', borderRadius: '3px', fontFamily: 'monospace', fontWeight: 600 }}>
                              ↻ {activeEditElement.custom_metadata.repeatMin ?? 0}..{(activeEditElement.custom_metadata.repeatMax ?? 1) === -1 ? '*' : activeEditElement.custom_metadata.repeatMax}
                            </span>
                          )}
                        </div>
                        {/* PROPERTIES TAB */}
                        {rightTab === 'properties' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <IntlProvider locale="en" messages={enMessages}>
                              <FormElementsEdit
                                key={activeEditElement.id}
                                element={activeEditElement}
                                updateElement={(updated: any) => {
                                  updateElementFnRef.current?.(updated);
                                  setActiveEditElement({ ...updated });
                                }}
                                preview={{ state: { data: builderItems } }}
                                showCorrectColumn={false}
                                files={[]}
                              />
                            </IntlProvider>

                            {/* CUSTOM LAYOUT PROPERTIES */}
                            {['FieldSet', 'TwoColumnRow', 'ThreeColumnRow', 'MultiColumnRow'].includes(activeEditElement.element) && (
                              <div className="inspector-section" style={{ marginTop: '0.25rem' }}>
                                <div className="inspector-section-title">
                                  <span className="section-emoji">📐</span> Layout Options
                                </div>
                                {activeEditElement.element === 'FieldSet' && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                    <label className="inspector-checkbox-row">
                                      <input
                                        type="checkbox"
                                        checked={activeEditElement.custom_metadata?.collapsible === true}
                                        onChange={(e) => {
                                          const updated = {
                                            ...activeEditElement,
                                            custom_metadata: {
                                              ...(activeEditElement.custom_metadata || {}),
                                              collapsible: e.target.checked
                                            }
                                          };
                                          updateElementFnRef.current?.(updated);
                                          setActiveEditElement(updated);
                                        }}
                                      />
                                      <span className="inspector-checkbox-label">Collapsible Group</span>
                                    </label>
                                    {activeEditElement.custom_metadata?.collapsible && (
                                      <label className="inspector-checkbox-row" style={{ marginLeft: '0.75rem' }}>
                                        <input
                                          type="checkbox"
                                          checked={activeEditElement.custom_metadata?.initiallyCollapsed === true}
                                          onChange={(e) => {
                                            const updated = {
                                              ...activeEditElement,
                                              custom_metadata: {
                                                ...(activeEditElement.custom_metadata || {}),
                                                initiallyCollapsed: e.target.checked
                                              }
                                            };
                                            updateElementFnRef.current?.(updated);
                                            setActiveEditElement(updated);
                                          }}
                                        />
                                        <span className="inspector-checkbox-label">Initially Collapsed</span>
                                      </label>
                                    )}
                                  </div>
                                )}

                                {['TwoColumnRow', 'ThreeColumnRow', 'MultiColumnRow'].includes(activeEditElement.element) && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                    <div className="inspector-field-group">
                                      <label>Gap Size</label>
                                      <input
                                        type="text"
                                        className="inspector-input"
                                        placeholder="e.g. 1rem or 16px"
                                        value={activeEditElement.custom_metadata?.gap || ''}
                                        onChange={(e) => {
                                          const updated = {
                                            ...activeEditElement,
                                            custom_metadata: {
                                              ...(activeEditElement.custom_metadata || {}),
                                              gap: e.target.value
                                            }
                                          };
                                          updateElementFnRef.current?.(updated);
                                          setActiveEditElement(updated);
                                        }}
                                      />
                                    </div>
                                    
                                    <div className="inspector-field-group">
                                      <label>Column Spans</label>
                                      {Array.from({ length: activeEditElement.element === 'TwoColumnRow' ? 2 : (activeEditElement.element === 'ThreeColumnRow' ? 3 : 4) }).map((_, colIdx) => {
                                        const spans = activeEditElement.custom_metadata?.colSpans?.[colIdx] || {
                                          spanlarge: activeEditElement.element === 'TwoColumnRow' ? 6 : (activeEditElement.element === 'ThreeColumnRow' ? 4 : 3),
                                          spanmedium: activeEditElement.element === 'TwoColumnRow' ? 6 : (activeEditElement.element === 'ThreeColumnRow' ? 4 : 3),
                                          spansmall: 12
                                        };
                                        const updateColSpan = (key: 'spanlarge' | 'spanmedium' | 'spansmall', val: number) => {
                                          const colSpans = [...(activeEditElement.custom_metadata?.colSpans || [])];
                                          const colCount = activeEditElement.element === 'TwoColumnRow' ? 2 : (activeEditElement.element === 'ThreeColumnRow' ? 3 : 4);
                                          for (let i = 0; i < colCount; i++) {
                                            if (!colSpans[i]) {
                                              colSpans[i] = {
                                                spanlarge: activeEditElement.element === 'TwoColumnRow' ? 6 : (activeEditElement.element === 'ThreeColumnRow' ? 4 : 3),
                                                spanmedium: activeEditElement.element === 'TwoColumnRow' ? 6 : (activeEditElement.element === 'ThreeColumnRow' ? 4 : 3),
                                                spansmall: 12
                                              };
                                            }
                                          }
                                          colSpans[colIdx] = {
                                            ...colSpans[colIdx],
                                            [key]: val
                                          };
                                          const updated = {
                                            ...activeEditElement,
                                            custom_metadata: {
                                              ...(activeEditElement.custom_metadata || {}),
                                              colSpans
                                            }
                                          };
                                          updateElementFnRef.current?.(updated);
                                          setActiveEditElement(updated);
                                        };

                                        return (
                                          <div key={colIdx} style={{ background: '#f8fafc', padding: '0.6rem 0.7rem', borderRadius: '7px', border: '1px solid #e2e8f0', marginBottom: '0.35rem' }}>
                                            <div style={{ fontSize: '0.73rem', fontWeight: 600, color: '#475569', marginBottom: '0.4rem' }}>Column {colIdx + 1}</div>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.4rem' }}>
                                              <div className="inspector-field-group">
                                                <label>Desktop</label>
                                                <select
                                                  className="inspector-select"
                                                  value={spans.spanlarge}
                                                  onChange={(e) => updateColSpan('spanlarge', parseInt(e.target.value))}
                                                >
                                                  {Array.from({ length: 12 }, (_, i) => i + 1).map(v => (
                                                    <option key={v} value={v}>{v}</option>
                                                  ))}
                                                </select>
                                              </div>
                                              <div className="inspector-field-group">
                                                <label>Tablet</label>
                                                <select
                                                  className="inspector-select"
                                                  value={spans.spanmedium}
                                                  onChange={(e) => updateColSpan('spanmedium', parseInt(e.target.value))}
                                                >
                                                  {Array.from({ length: 12 }, (_, i) => i + 1).map(v => (
                                                    <option key={v} value={v}>{v}</option>
                                                  ))}
                                                </select>
                                              </div>
                                              <div className="inspector-field-group">
                                                <label>Mobile</label>
                                                <select
                                                  className="inspector-select"
                                                  value={spans.spansmall}
                                                  onChange={(e) => updateColSpan('spansmall', parseInt(e.target.value))}
                                                >
                                                  {Array.from({ length: 12 }, (_, i) => i + 1).map(v => (
                                                    <option key={v} value={v}>{v}</option>
                                                  ))}
                                                </select>
                                              </div>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                               </div>
                             )}

                             {/* IFRAME PROPERTIES */}
                             {activeEditElement.element === 'CustomElement' && activeEditElement.custom_metadata?.type === 'IframeField' && (
                               <div className="inspector-section" style={{ marginTop: '0.25rem' }}>
                                 <div className="inspector-section-title">
                                   <span className="section-emoji">🌐</span> Iframe Options
                                 </div>
                                 <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                   <div className="inspector-field-group">
                                     <label>Iframe URL</label>
                                     <input
                                       type="text"
                                       className="inspector-input"
                                       placeholder="https://example.com"
                                       value={activeEditElement.props?.url || ''}
                                       onChange={(e) => {
                                         const updated = {
                                           ...activeEditElement,
                                           props: { ...(activeEditElement.props || {}), url: e.target.value }
                                         };
                                         updateElementFnRef.current?.(updated);
                                         setActiveEditElement(updated);
                                       }}
                                     />
                                   </div>
                                   <div className="inspector-field-group">
                                     <label>Height</label>
                                     <input
                                       type="text"
                                       className="inspector-input"
                                       placeholder="e.g. 400px, 100%, 100vh"
                                       value={activeEditElement.props?.height || ''}
                                       onChange={(e) => {
                                         const updated = {
                                           ...activeEditElement,
                                           props: { ...(activeEditElement.props || {}), height: e.target.value }
                                         };
                                         updateElementFnRef.current?.(updated);
                                         setActiveEditElement(updated);
                                       }}
                                     />
                                   </div>
                                   <label className="inspector-checkbox-row">
                                     <input
                                       type="checkbox"
                                       checked={activeEditElement.props?.border !== false}
                                       onChange={(e) => {
                                         const updated = {
                                           ...activeEditElement,
                                           props: { ...(activeEditElement.props || {}), border: e.target.checked }
                                         };
                                         updateElementFnRef.current?.(updated);
                                         setActiveEditElement(updated);
                                       }}
                                     />
                                     <span className="inspector-checkbox-label">Show Border</span>
                                   </label>
                                 </div>
                               </div>
                             )}
                             {/* AQL PREFILL PROPERTY INSPECTOR - meaningless for anything that
                                 isn't a value field: static content has nothing to prefill into,
                                 a Row has no value of its own, and a Button triggers an action
                                 rather than holding data. FieldSet is kept - it has its own
                                 "Group ID" branch below for prefilling an entire cluster. */}
                             {!(
                               ElementKinds.STATIC_CONTENT_ELEMENTS.includes(activeEditElement.element)
                               || ElementKinds.ACTION_ELEMENTS.includes(activeEditElement.element)
                               || (ElementKinds.STRUCTURAL_ELEMENTS.includes(activeEditElement.element) && activeEditElement.element !== 'FieldSet')
                             ) && (
                             <div className="inspector-section" style={{ marginTop: '0.75rem', borderTop: '1px solid #e2e8f0', paddingTop: '0.75rem' }}>
                               <div className="inspector-section-title" style={{ fontSize: '0.82rem', fontWeight: 600, color: '#1e293b', marginBottom: '0.4rem' }}>
                                 🔍 AQL Prefill (HIP) Mapping
                               </div>

                               {activeEditElement.element === 'FieldSet' ? (
                                 <div>
                                   <label className="inspector-label" style={{ fontSize: '0.75rem', color: '#475569' }}>
                                     Group ID (Cluster / Section)
                                   </label>
                                   <input
                                     type="text"
                                     className="inspector-input"
                                     value={activeEditElement.custom_metadata?.groupId || activeEditElement.field_name || activeEditElement.id || ''}
                                     placeholder="z. B. vitalsGroup"
                                     onChange={(e) => {
                                       const updated = {
                                         ...activeEditElement,
                                         custom_metadata: {
                                           ...(activeEditElement.custom_metadata || {}),
                                           groupId: e.target.value,
                                         },
                                       };
                                       updateElementFnRef.current?.(updated);
                                       setActiveEditElement(updated);
                                     }}
                                   />
                                   <p style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '0.2rem' }}>
                                     AQL-Ergebnisse dieser Gruppe werden über den Gruppenbutton gemeinsam geladen.
                                   </p>
                                 </div>
                               ) : (
                                 <div>
                                   {(() => {
                                     const currentFieldId = activeEditElement.field_name || activeEditElement.id || activeEditElement.name;
                                     const aqlConfig = form.canonical_json.settings?.aqlPrefill;
                                     const existingMapping = aqlConfig?.mappings?.find((m: any) => m.target.fieldId === currentFieldId);

                                     return (
                                       <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                         <label className="inspector-label" style={{ fontSize: '0.75rem', color: '#475569' }}>
                                           Mapped AQL Result Path
                                         </label>
                                         <input
                                           type="text"
                                           className="inspector-input"
                                           value={existingMapping?.resultPath || ''}
                                           placeholder="z. B. weight oder rows[0].weight"
                                           onChange={(e) => {
                                             const resultPath = e.target.value;
                                             const currentConfig = form.canonical_json.settings?.aqlPrefill || {
                                               id: 'aql-prefill-main',
                                               name: 'AQL Vorbelegung',
                                               queryMode: 'latest',
                                               executionMode: 'manual',
                                               query: { aql: '' },
                                               parameters: [{ queryParameter: '$ehrId', source: 'ehrId' }],
                                               mappings: [],
                                               behavior: { cacheResult: true, showSource: true, showTimestamp: true, confirmOverwrite: true },
                                             };

                                             let mappings = [...(currentConfig.mappings || [])];
                                             if (existingMapping) {
                                               if (resultPath.trim()) {
                                                 mappings = mappings.map((m) => m.id === existingMapping.id ? { ...m, resultPath } : m);
                                               } else {
                                                 mappings = mappings.filter((m) => m.id !== existingMapping.id);
                                               }
                                             } else if (resultPath.trim()) {
                                               mappings.push({
                                                 id: `map_${Date.now()}`,
                                                 resultPath,
                                                 target: { fieldId: currentFieldId },
                                               });
                                             }

                                             const updatedConfig = { ...currentConfig, mappings };
                                             const updatedForm = {
                                               ...form,
                                               canonical_json: {
                                                 ...form.canonical_json,
                                                 settings: {
                                                   ...(form.canonical_json.settings || {}),
                                                   aqlPrefill: updatedConfig,
                                                 },
                                               },
                                             };
                                             formRef.current = updatedForm;
                                             setForm(updatedForm);
                                             setTimeout(() => handleSave(builderItems), 0);
                                           }}
                                         />
                                         <span style={{ fontSize: '0.7rem', color: existingMapping ? '#16a34a' : '#64748b' }}>
                                           {existingMapping ? `✓ Mit Pfad '${existingMapping.resultPath}' verknüpft` : 'Nicht mit AQL verknüpft'}
                                         </span>
                                       </div>
                                     );
                                   })()}
                                 </div>
                               )}
                             </div>
                             )}
                           </div>
                         )}

                        {/* OPENEHR TAB */}
                        {rightTab === 'openehr' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <h4>Developer Inspector</h4>
                            {activeEditElement.custom_metadata?.binding ? (
                              <div className="inspector-read-only-box">
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Label:</span>
                                  <span className="inspector-read-only-value">{activeEditElement.label}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Internal ID:</span>
                                  <span className="inspector-read-only-value" style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>{activeEditElement.id}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Field Name:</span>
                                  <span className="inspector-read-only-value">{activeEditElement.field_name}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">RM Type:</span>
                                  <span className="inspector-read-only-value">{activeEditElement.custom_metadata.binding.rmType || '—'}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Archetype Node ID:</span>
                                  <span className="inspector-read-only-value" style={{ fontFamily: 'monospace' }}>{activeEditElement.custom_metadata.binding.archetypeNodeId || '—'}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Archetype:</span>
                                  <span className="inspector-read-only-value" style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>{activeEditElement.custom_metadata.binding.archetypeId || '—'}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">RM Version:</span>
                                  <span className="inspector-read-only-value">{activeEditElement.custom_metadata.binding.rmVersion || '—'}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">AQL Path:</span>
                                  <span className="inspector-read-only-value" style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>
                                    {activeEditElement.custom_metadata.binding.path || '—'}
                                  </span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Template Path:</span>
                                  <span className="inspector-read-only-value" style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>
                                    {activeEditElement.custom_metadata.binding.flatPath || '—'}
                                  </span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Template ID:</span>
                                  <span className="inspector-read-only-value" style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>{activeEditElement.custom_metadata.binding.templateId || '—'}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Template Version:</span>
                                  <span className="inspector-read-only-value">{activeEditElement.custom_metadata.binding.templateVersion || '—'}</span>
                                </div>
                                {activeEditElement.default_value !== undefined && activeEditElement.default_value !== '' && (
                                  <div className="inspector-read-only-row">
                                    <span className="inspector-read-only-label">Default Value:</span>
                                    <span className="inspector-read-only-value">{String(activeEditElement.default_value)}</span>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p style={{ color: '#64748b', fontSize: '0.85rem' }}>This is a layout element. No openEHR binding is present.</p>
                            )}
                          </div>
                        )}

                        {/* JSON TAB */}
                        {rightTab === 'json' && (
                          <div>
                            <h4>Canonical Field JSON</h4>
                            <pre style={{ background: '#0f172a', color: '#e2e8f0', padding: '0.75rem', borderRadius: '6px', fontSize: '0.75rem', overflow: 'auto', maxHeight: '350px' }}>
                              {JSON.stringify(activeEditElement, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p style={{ color: '#64748b', fontSize: '0.85rem' }}>Select a field in the canvas to configure it.</p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="panel-tabs">
                    <button className={`panel-tab ${formTab === 'general' ? 'active' : ''}`} onClick={() => setFormTab('general')}>
                      General
                    </button>
                    <button className={`panel-tab ${formTab === 'openehr' ? 'active' : ''}`} onClick={() => setFormTab('openehr')}>
                      openEHR
                    </button>
                    <button className={`panel-tab ${formTab === 'export' ? 'active' : ''}`} onClick={() => setFormTab('export')}>
                      Export
                    </button>
                    <button className={`panel-tab ${formTab === 'submission' ? 'active' : ''}`} onClick={() => setFormTab('submission')}>
                      Submission
                    </button>
                    <button className={`panel-tab ${formTab === 'aqlPrefill' ? 'active' : ''}`} onClick={() => setFormTab('aqlPrefill')}>
                      AQL Prefill
                    </button>
                  </div>

                  <div className="panel-content">
                    <div className="inspector-tab-content">
                      {formTab === 'general' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <h4>General Settings</h4>
                          
                          <div className="inspector-field-group">
                            <label>Form Name</label>
                            <input 
                              type="text" 
                              className="inspector-input" 
                              value={form.name || ''} 
                              onChange={(e) => updateFormGeneral('name', e.target.value)} 
                              onBlur={() => handleSave(builderItems)}
                            />
                          </div>

                          <div className="inspector-field-group">
                            <label>Technical ID</label>
                            <input 
                              type="text" 
                              className="inspector-input" 
                              value={form.canonical_json.id || ''} 
                              readOnly 
                              style={{ background: '#f1f5f9', cursor: 'not-allowed' }}
                            />
                          </div>

                          <div className="inspector-field-group">
                            <label>Version</label>
                            <input 
                              type="text" 
                              className="inspector-input" 
                              value={form.version || ''} 
                              onChange={(e) => updateFormGeneral('version', e.target.value)} 
                              onBlur={() => handleSave(builderItems)}
                            />
                          </div>

                          <div className="inspector-field-group">
                            <label>Status</label>
                            <select 
                              className="inspector-select" 
                              value={form.status || 'draft'} 
                              onChange={(e) => updateFormGeneral('status', e.target.value)}
                              onBlur={() => handleSave(builderItems)}
                            >
                              <option value="draft">Draft</option>
                              <option value="active">Active</option>
                              <option value="archived">Archived</option>
                            </select>
                          </div>

                          <div className="inspector-field-group">
                            <label>Description</label>
                            <textarea 
                              className="inspector-input" 
                              rows={3} 
                              value={form.canonical_json.settings?.description || ''} 
                              onChange={(e) => updateFormGeneral('description', e.target.value)}
                              onBlur={() => handleSave(builderItems)}
                            />
                          </div>

                          <div className="inspector-field-group">
                            <label>Default Language</label>
                            <input 
                              type="text" 
                              className="inspector-input" 
                              value={form.canonical_json.settings?.defaultLocale || 'de-DE'} 
                              onChange={(e) => updateFormGeneral('defaultLocale', e.target.value)}
                              onBlur={() => handleSave(builderItems)}
                            />
                          </div>

                          <div className="inspector-field-group">
                            <label>Authors</label>
                            <input 
                              type="text" 
                              className="inspector-input" 
                              value={form.canonical_json.settings?.authors || ''} 
                              onChange={(e) => updateFormGeneral('authors', e.target.value)}
                              onBlur={() => handleSave(builderItems)}
                            />
                          </div>

                          <div className="inspector-field-group">
                            <label>Tags</label>
                            <input 
                              type="text" 
                              className="inspector-input" 
                              placeholder="e.g. konsil, cardiology"
                              value={form.canonical_json.settings?.tags?.join(', ') || ''} 
                              onChange={(e) => {
                                const tagsList = e.target.value.split(',').map((t: string) => t.trim()).filter(Boolean);
                                updateFormGeneral('tags', tagsList);
                              }}
                              onBlur={() => handleSave(builderItems)}
                            />
                          </div>
                        </div>
                      )}

                      {formTab === 'openehr' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <h4>openEHR Source Metadata</h4>
                          {form.canonical_json.sourceTemplates?.[0] ? (
                            <>
                              <div className="inspector-read-only-box">
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Template ID:</span>
                                  <span className="inspector-read-only-value">{form.canonical_json.sourceTemplates[0].id}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Version:</span>
                                  <span className="inspector-read-only-value">{form.canonical_json.sourceTemplates[0].version || '1.0.0'}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Alias:</span>
                                  <span className="inspector-read-only-value">{form.canonical_json.sourceTemplates[0].alias}</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Type:</span>
                                  <span className="inspector-read-only-value">openEHR WebTemplate</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Template Fields:</span>
                                  <span className="inspector-read-only-value">{totalFields} total</span>
                                </div>
                                <div className="inspector-read-only-row">
                                  <span className="inspector-read-only-label">Fields Used:</span>
                                  <span className="inspector-read-only-value">{fieldsInForm} in form</span>
                                </div>
                              </div>

                              <div style={{ marginTop: '0.5rem', background: '#f8fafc', padding: '0.75rem', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '0.78rem', color: '#64748b' }}>
                                <strong>⚠️ Template editing is disabled:</strong><br />
                                This form is linked to the read-only openEHR source. Elements are mapped but the archetypes themselves remain unaltered.
                              </div>

                              <h4 style={{ marginTop: '1rem' }}>Display Configurations</h4>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.82rem', fontWeight: 'normal', cursor: 'pointer' }}>
                                  <input 
                                    type="checkbox" 
                                    checked={form.canonical_json.settings?.showTechnicalPaths ?? true} 
                                    onChange={(e) => {
                                      updateFormGeneral('showTechnicalPaths', e.target.checked);
                                      setTimeout(() => handleSave(builderItems), 0);
                                    }}
                                  />
                                  Show technical paths in canvas
                                </label>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.82rem', fontWeight: 'normal', cursor: 'pointer' }}>
                                  <input 
                                    type="checkbox" 
                                    checked={form.canonical_json.settings?.showStructuralNodes ?? true} 
                                    onChange={(e) => {
                                      updateFormGeneral('showStructuralNodes', e.target.checked);
                                      setTimeout(() => handleSave(builderItems), 0);
                                    }}
                                  />
                                  Show structural nodes in canvas
                                </label>
                              </div>



                              <div className="inspector-field-group" style={{ marginTop: '1.5rem' }}>
                                <label>Default Runtime Mode</label>
                                <select 
                                  className="inspector-select" 
                                  value={form.canonical_json.settings?.runtime?.defaultMode || 'create'}
                                  onChange={(e) => updateRuntimeSetting('defaultMode', e.target.value)}
                                  onBlur={() => handleSave(builderItems)}
                                >
                                  <option value="create">Create (Start empty, save as new)</option>
                                  <option value="edit">Edit (Load existing, update version)</option>
                                  <option value="prefill">Prefill (Load existing, save as new)</option>
                                  <option value="view">View (Read-only)</option>
                                </select>
                                <p style={{ color: '#64748b', fontSize: '0.75rem', marginTop: '0.5rem' }}>
                                  The default operating mode for the form if no explicit mode is provided in the URL. 
                                  Note: "Edit" and "Prefill" modes typically require an existing composition reference.
                                </p>
                              </div>
                            </>
                          ) : (
                            <p style={{ color: '#64748b', fontSize: '0.85rem' }}>No openEHR template imports found.</p>
                          )}
                        </div>
                      )}


                      {formTab === 'submission' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <h4>Submission Routing</h4>
                          <p style={{ color: '#64748b', fontSize: '0.82rem', margin: 0 }}>
                            Standardmäßig sendet die Runtime direkt an EHRbase. n8n kann einzelne Lade-, Speicher- und Validierungsphasen synchron erweitern; der Submit-Webhook ist optional und wird nur bei aktivierter Submit-Route verwendet.
                          </p>
                          <div className="inspector-read-only-box">
                            <div className="inspector-read-only-row">
                              <span className="inspector-read-only-label">Aktueller Modus:</span>
                              <span className="inspector-read-only-value">{form.canonical_json.settings?.submission?.mode === 'workflow' ? `Workflow (${form.canonical_json.settings.submission.workflow?.engine || 'unbekannt'})` : 'Direkt EHRbase'}</span>
                            </div>
                            {(form.canonical_json.settings?.submission?.workflow?.publicWebhookUrl || form.canonical_json.settings?.submission?.workflow?.webhookUrl) && <div className="inspector-read-only-row"><span className="inspector-read-only-label">Webhook:</span><span className="inspector-read-only-value" style={{ wordBreak: 'break-all' }}>{form.canonical_json.settings.submission.workflow.publicWebhookUrl || form.canonical_json.settings.submission.workflow.webhookUrl}</span></div>}
                          </div>
                          <PluginHost
                            slot="settings"
                            scope="form"
                            title="Submission Plugins"
                            context={{ formId: id, form: form.canonical_json, data: form.canonical_json.settings?.submission || {} }}
                            onResult={(result) => {
                              if (!result.data || !formRef.current) return;
                              const updated = { ...formRef.current, canonical_json: result.data };
                              formRef.current = updated;
                              setForm(updated);
                              setTimeout(() => handleSave(builderItems), 0);
                            }}
                          />
                        </div>
                      )}
                      {formTab === 'aqlPrefill' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <ExtensionSlot
                            name="designer:aql-prefill"
                            context={{
                              config: form.canonical_json.settings?.aqlPrefill || {
                                id: 'aql-prefill-main', name: 'AQL Vorbelegung', queryMode: 'latest', executionMode: 'manual',
                                query: { aql: '' }, parameters: [{ queryParameter: '$ehrId', source: 'ehrId' }], mappings: [],
                                behavior: { cacheResult: true, showSource: true, showTimestamp: true, confirmOverwrite: true },
                              },
                              availableFieldIds: (() => {
                                const ids: string[] = [];
                                const walk = (node: any) => { if (node.id || node.name) ids.push(node.id || node.name); node.children?.forEach(walk); };
                                if (form.canonical_json.layout) walk(form.canonical_json.layout);
                                return Array.from(new Set(ids));
                              })(),
                              onChange: (updatedConfig: unknown) => {
                                if (!formRef.current) return;
                                const currentSettings = formRef.current.canonical_json.settings || {};
                                const updatedForm = { ...formRef.current, canonical_json: { ...formRef.current.canonical_json, settings: { ...currentSettings, aqlPrefill: updatedConfig } } };
                                formRef.current = updatedForm;
                                setForm(updatedForm);
                                setTimeout(() => handleSave(builderItems), 0);
                              },
                            }}
                          />
                        </div>
                      )}
                      {formTab === 'export' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <h4>Validation & Export</h4>
                          
                          <div className="inspector-read-only-box">
                            <div className="inspector-read-only-row">
                              <span className="inspector-read-only-label">Validation Status:</span>
                              <span className={`bottom-stat-status ${isFormValid ? 'ok' : 'warning'}`} style={{ color: 'white', display: 'inline-block' }}>
                                {isFormValid ? '✓ Valid' : 'Warnings'}
                              </span>
                            </div>
                            <div className="inspector-read-only-row">
                              <span className="inspector-read-only-label">Total warnings:</span>
                              <span className="inspector-read-only-value" style={{ fontFamily: 'sans-serif' }}>{warnings.length} items</span>
                            </div>
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
                            <button 
                              className="btn-workbench success" 
                              style={{ width: '100%', padding: '0.6rem' }}
                              onClick={() => handleSave(builderItems)}
                            >
                              💾 Save All Settings
                            </button>
                            <button 
                              className="btn-workbench secondary" 
                              style={{ width: '100%', padding: '0.6rem' }}
                              onClick={() => navigate(`/forms/${id}/export`)}
                            >
                              Export Cambio Form ↗
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          /* PREVIEW MODE split-pane display */
          <div className="split-pane-container">
            {/* Clinical Preview (Interactive Form Render) */}
            <div className="split-pane-left">
              <h3>Clinical Preview</h3>
              <div className="card" style={{ padding: '2rem', marginTop: '1.5rem', background: '#f8fafc', borderRadius: '12px' }}>
                <h4 style={{ marginBottom: '1.5rem', borderBottom: '1px solid #cbd5e1', paddingBottom: '0.5rem' }}>{form.name}</h4>
                
                {/* Validation Status Banner */}
                {Object.keys(validationErrorsList).length > 0 ? (
                  <div style={{ background: '#fff7ed', border: '1px solid #ffedd5', borderRadius: '8px', padding: '1rem', marginBottom: '1.5rem' }}>
                    <h5 style={{ margin: 0, color: '#c2410c', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>
                      ⚠️ Validation Failed ({Object.keys(validationErrorsList).length} errors)
                    </h5>
                    <ul style={{ margin: '0.5rem 0 0 0', paddingLeft: '1.25rem', fontSize: '0.78rem', color: '#9a3412', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {Object.values(validationErrorsList).map((err, idx) => (
                        <li key={idx}>{err}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div style={{ background: '#f0fdf4', border: '1px solid #dcfce7', borderRadius: '8px', padding: '0.75rem 1rem', marginBottom: '1.5rem', color: '#15803d', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 500 }}>
                    ✓ Form Valid & Ready for Export
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  {(() => {
                    const renderPreviewItem = (item: any): React.ReactNode => {
                      if (!item) return null;

                      if (item.element === 'Header') return <h3 key={item.id} style={{ margin: '0.5rem 0' }}>{item.text}</h3>;
                      if (item.element === 'Paragraph') return <p key={item.id} style={{ margin: '0.25rem 0', color: '#475569', fontSize: '0.9rem' }}>{item.text}</p>;
                      if (item.element === 'LineBreak') return <hr key={item.id} style={{ border: 'none', borderTop: '1px solid #cbd5e1', margin: '1rem 0' }} />;

                      const isTwoCol = item.element === 'TwoColumnRow';
                      const isThreeCol = item.element === 'ThreeColumnRow';
                      const isMultiCol = item.element === 'MultiColumnRow';

                      if (isTwoCol || isThreeCol || isMultiCol) {
                        const colCount = isTwoCol ? 2 : (isThreeCol ? 3 : (item.col_count || 4));
                        const className = isTwoCol ? 'col-md-6' : (isThreeCol ? 'col-md-4' : 'col-md-3');

                        return (
                          <div key={item.id} className="row" style={{ display: 'flex', flexWrap: 'wrap', margin: '0.5rem -8px', width: '100%' }}>
                            {Array.from({ length: colCount }).map((_, c) => {
                              const child = builderItems.find(x => x.parentId === item.id && x.col === c);
                              return (
                                <div key={c} className={className} style={{ flex: `0 0 ${100/colCount}%`, maxWidth: `${100/colCount}%`, padding: '0 8px', boxSizing: 'border-box' }}>
                                  {child ? renderPreviewItem(child) : <div style={{ minHeight: '3rem', border: '1px dashed #cbd5e1', borderRadius: '6px', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: '0.75rem' }}>Empty Column</div>}
                                </div>
                              );
                            })}
                          </div>
                        );
                      }

                      if (item.element === 'FieldSet') {
                        const children = builderItems.filter(x => x.parentId === item.id);
                        const isRootContainer = !item.parentId;
                        const meta = item.custom_metadata || {};
                        const isRepeatable = meta.repeatable === true;
                        const repeatMax = meta.repeatMax ?? 1;
                        const repeatMin = meta.repeatMin ?? 0;
                        const parentInstId = item._parentInstanceId || 'root';
                        const repeatKey = `${parentInstId}/${item.id}`;

                        const renderContainerContent = (instanceIdx?: number, instanceId?: string, totalInstances?: number) => {
                          const hasError = instanceId ? Object.keys(validationErrorsList).some(errKey => errKey.startsWith(`${instanceId}/`)) : false;
                          const isCollapsed = instanceId ? (collapsedInstances[instanceId] === true && !hasError) : false;
                          const title = instanceId && instanceIdx !== undefined ? getInstanceTitle(item, instanceId, instanceIdx, fieldValues) : item.text;

                          if (isCollapsed && instanceId) {
                            return (
                              <div 
                                className={isRootContainer ? 'preview-card' : 'preview-fieldset'} 
                                onClick={() => toggleCollapse(instanceId)}
                                style={{
                                  border: '1px solid #e2e8f0',
                                  borderRadius: '8px',
                                  padding: '0.75rem 1rem',
                                  background: '#f8fafc',
                                  cursor: 'pointer',
                                  marginBottom: '0.5rem',
                                  marginTop: '0.5rem',
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  transition: 'background 0.15s ease'
                                }}
                                onMouseOver={(e) => { e.currentTarget.style.background = '#f1f5f9'; }}
                                onMouseOut={(e) => { e.currentTarget.style.background = '#f8fafc'; }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                  <span style={{ color: '#64748b', fontSize: '0.75rem' }}>▶</span>
                                  <h4 style={{ 
                                    fontSize: isRootContainer ? '0.9rem' : '0.82rem', 
                                    fontWeight: 600, 
                                    color: '#475569', 
                                    margin: 0
                                  }}>
                                    {title}
                                  </h4>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                  {totalInstances !== undefined && totalInstances > repeatMin && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); removeInstance(repeatKey, instanceId, meta); }}
                                      style={{
                                        background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer',
                                        fontSize: '0.8rem', padding: '0.15rem 0.4rem', borderRadius: '4px'
                                      }}
                                      onMouseOver={(e) => (e.currentTarget.style.color = '#ef4444')}
                                      onMouseOut={(e) => (e.currentTarget.style.color = '#94a3b8')}
                                      title="Instanz entfernen"
                                    >
                                      ✕
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          }

                          return (
                            <div className={isRootContainer ? 'preview-card' : 'preview-fieldset'} style={{
                              border: hasError ? '1px solid #ea580c' : '1px solid #e2e8f0',
                              borderRadius: '8px',
                              padding: isRootContainer ? '1.25rem' : '1rem',
                              background: isRootContainer ? 'white' : '#f8fafc',
                              boxShadow: isRootContainer ? '0 1px 3px 0 rgba(0,0,0,0.05)' : 'none',
                              marginBottom: isRepeatable ? '0.5rem' : '1rem',
                              marginTop: '0.5rem'
                            }}>
                              <div 
                                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: instanceId ? 'pointer' : 'default' }}
                                onClick={() => instanceId && toggleCollapse(instanceId)}
                              >
                                <h4 style={{ 
                                  fontSize: isRootContainer ? '0.95rem' : '0.85rem', 
                                  fontWeight: 600, 
                                  color: '#1e293b', 
                                  marginTop: 0,
                                  marginBottom: '0.75rem',
                                  borderBottom: isRootContainer ? '1px solid #f1f5f9' : 'none',
                                  paddingBottom: isRootContainer ? '0.5rem' : 0,
                                  flex: 1,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.4rem'
                                }}>
                                  {instanceId && <span style={{ color: '#64748b', fontSize: '0.75rem' }}>▼</span>}
                                  {title}
                                  {isRepeatable && instanceIdx === undefined && (
                                    <span style={{ fontSize: '0.7rem', color: '#94a3b8', fontWeight: 400, marginLeft: '0.5rem' }}>
                                      {repeatMin}..{repeatMax === -1 ? '*' : repeatMax}
                                    </span>
                                  )}
                                  {hasError && (
                                    <span style={{ fontSize: '0.65rem', color: '#ea580c', background: '#fff7ed', padding: '0.1rem 0.35rem', borderRadius: '3px', border: '1px solid #ffedd5', fontWeight: 600 }}>
                                      ⚠️ Fehlerhaft
                                    </span>
                                  )}
                                </h4>
                                {instanceId && totalInstances !== undefined && totalInstances > repeatMin && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); removeInstance(repeatKey, instanceId, meta); }}
                                    style={{
                                      background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer',
                                      fontSize: '0.8rem', padding: '0.15rem 0.4rem', borderRadius: '4px',
                                      marginBottom: '0.75rem'
                                    }}
                                    onMouseOver={(e) => (e.currentTarget.style.color = '#ef4444')}
                                    onMouseOut={(e) => (e.currentTarget.style.color = '#94a3b8')}
                                    title="Instanz entfernen"
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                {children.map(child => renderPreviewItem({ ...child, _parentInstanceId: instanceId }))}
                              </div>
                            </div>
                          );
                        };

                        if (!isRepeatable) {
                          return <div key={item.id}>{renderContainerContent(undefined, item._parentInstanceId)}</div>;
                        }

                        // Repeatable container: render instances
                        const instances = getInstances(repeatKey, meta);
                        const canAdd = repeatMax === -1 || instances.length < repeatMax;

                        return (
                          <div key={item.id}>
                            {instances.length === 0 ? null : instances.map((instId, idx) => (
                              <div key={instId}>
                                {renderContainerContent(idx, instId, instances.length)}
                              </div>
                            ))}
                            {canAdd && (
                              <button
                                onClick={() => addInstance(repeatKey, meta)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                                  background: 'none', border: '1px dashed #cbd5e1', borderRadius: '6px',
                                  padding: '0.5rem 1rem', color: '#64748b', cursor: 'pointer',
                                  fontSize: '0.8rem', width: '100%', justifyContent: 'center',
                                  marginBottom: '1rem', transition: 'all 0.15s ease'
                                }}
                                onMouseOver={(e) => { e.currentTarget.style.borderColor = '#3b82f6'; e.currentTarget.style.color = '#3b82f6'; }}
                                onMouseOut={(e) => { e.currentTarget.style.borderColor = '#cbd5e1'; e.currentTarget.style.color = '#64748b'; }}
                              >
                                + {item.text} hinzufügen
                              </button>
                            )}
                          </div>
                        );
                      }

                      // Normal leaf inputs
                      const leafMeta = item.custom_metadata || {};
                      const isRepeatableField = leafMeta.repeatable === true;
                      const parentInstId = item._parentInstanceId || 'root';

                      const renderLeafInput = (keyPrefix?: string) => {
                        const valKey = keyPrefix ? keyPrefix : `${parentInstId}/${item.id}`;
                        const val = fieldValues[valKey];
                        const err = validationErrorsList[valKey];

                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.75rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <label style={{ fontWeight: 600, fontSize: '0.85rem', color: '#334155' }}>
                                {item.text} {item.required && <span style={{ color: '#dc2626' }}>*</span>}
                              </label>
                              {err && (
                                <span style={{ fontSize: '0.72rem', color: '#ea580c', fontWeight: 500 }}>
                                  ⚠️ {err}
                                </span>
                              )}
                            </div>
                            {item.element === 'Dropdown' ? (
                              <select 
                                className="inspector-select" 
                                style={{ maxWidth: '100%', padding: '0.4rem 0.6rem', fontSize: '0.85rem', border: err ? '1px solid #ea580c' : '1px solid #cbd5e1' }}
                                value={val || ''}
                                onChange={(e) => setFieldValues(prev => ({ ...prev, [valKey]: e.target.value }))}
                              >
                                <option value="">-- Select --</option>
                                {item.options?.map((opt: any, optIdx: number) => (
                                  <option key={opt.key ?? opt.value ?? optIdx} value={opt.value}>{opt.text}</option>
                                ))}
                              </select>
                            ) : item.element === 'NumberInput' ? (
                              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                <input 
                                  type="number" 
                                  className="inspector-input" 
                                  style={{ maxWidth: '200px', padding: '0.4rem 0.6rem', fontSize: '0.85rem', border: err ? '1px solid #ea580c' : '1px solid #cbd5e1' }} 
                                  value={val?.magnitude || ''}
                                  onChange={(e) => setFieldValues(prev => ({ 
                                    ...prev, 
                                    [valKey]: { 
                                      magnitude: e.target.value, 
                                      unit: val?.unit || (item.custom_metadata?.unitOptions && item.custom_metadata.unitOptions[0] ? (typeof item.custom_metadata.unitOptions[0] === 'string' ? item.custom_metadata.unitOptions[0] : item.custom_metadata.unitOptions[0].unit) : '')
                                    } 
                                  }))}
                                />
                                {item.custom_metadata?.unitOptions && item.custom_metadata.unitOptions.length > 0 && (
                                  item.custom_metadata.unitOptions.length === 1 ? (
                                    <span style={{ fontSize: '0.85rem', color: '#475569' }}>
                                      {typeof item.custom_metadata.unitOptions[0] === 'string' ? item.custom_metadata.unitOptions[0] : item.custom_metadata.unitOptions[0].unit}
                                    </span>
                                  ) : (
                                    <select
                                      className="inspector-select"
                                      style={{ maxWidth: '100px', padding: '0.2rem', fontSize: '0.8rem' }}
                                      value={val?.unit || ''}
                                      onChange={(e) => setFieldValues(prev => ({
                                        ...prev,
                                        [valKey]: {
                                          magnitude: val?.magnitude || '',
                                          unit: e.target.value
                                        }
                                      }))}
                                    >
                                      {item.custom_metadata.unitOptions.map((uOpt: any, uIdx: number) => {
                                        const uStr = typeof uOpt === 'string' ? uOpt : uOpt.unit;
                                        return <option key={uIdx} value={uStr}>{uStr}</option>;
                                      })}
                                    </select>
                                  )
                                )}
                              </div>
                            ) : item.element === 'TextArea' ? (
                              <textarea 
                                className="inspector-input" 
                                style={{ maxWidth: '100%', minHeight: '80px', padding: '0.4rem 0.6rem', fontSize: '0.85rem', border: err ? '1px solid #ea580c' : '1px solid #cbd5e1' }} 
                                placeholder={item.placeholder || ''} 
                                value={val || ''}
                                onChange={(e) => setFieldValues(prev => ({ ...prev, [valKey]: e.target.value }))}
                              />
                            ) : item.element === 'Range' ? (
                              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', maxWidth: '100%' }}>
                                <span style={{ fontSize: '0.8rem', color: '#64748b' }}>{item.min_value ?? 0}</span>
                                <input 
                                  type="range" 
                                  min={item.min_value ?? 0} 
                                  max={item.max_value ?? 100} 
                                  step={item.step ?? 1} 
                                  style={{ flex: 1 }} 
                                  value={val ?? item.min_value ?? 0}
                                  onChange={(e) => setFieldValues(prev => ({ ...prev, [valKey]: Number(e.target.value) }))}
                                />
                                <span style={{ fontSize: '0.8rem', color: '#64748b' }}>{item.max_value ?? 100}</span>
                              </div>
                            ) : item.element === 'Rating' ? (
                              <div style={{ display: 'flex', gap: '0.25rem', fontSize: '1.25rem', color: '#eab308' }}>
                                {"★".repeat(5)}
                              </div>
                            ) : item.element === 'RadioButtons' ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                {item.options?.map((opt: any, optIdx: number) => (
                                  <label key={opt.key ?? optIdx} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 'normal', fontSize: '0.82rem', cursor: 'pointer' }}>
                                    <input 
                                      type="radio" 
                                      name={`${item.id}_${keyPrefix || ''}`} 
                                      value={opt.value} 
                                      checked={val === opt.value}
                                      onChange={() => setFieldValues(prev => ({ ...prev, [valKey]: opt.value }))}
                                    />
                                    {opt.text}
                                  </label>
                                ))}
                              </div>
                            ) : item.element === 'Checkboxes' ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                {item.options?.map((opt: any, optIdx: number) => {
                                  const arrVal = Array.isArray(val) ? val : [];
                                  const isChecked = arrVal.includes(opt.value);
                                  return (
                                    <label key={opt.key ?? optIdx} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 'normal', fontSize: '0.82rem', cursor: 'pointer' }}>
                                      <input 
                                        type="checkbox" 
                                        value={opt.value} 
                                        checked={isChecked}
                                        onChange={(e) => {
                                          const nextArr = e.target.checked 
                                            ? [...arrVal, opt.value] 
                                            : arrVal.filter((x: any) => x !== opt.value);
                                          setFieldValues(prev => ({ ...prev, [valKey]: nextArr }));
                                        }}
                                      />
                                      {opt.text}
                                    </label>
                                  );
                                })}
                              </div>
                            ) : item.element === 'Tags' ? (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', maxWidth: '100%', border: '1px solid #cbd5e1', padding: '0.35rem', borderRadius: '6px', minHeight: '38px', background: 'white', alignItems: 'center' }}>
                                {item.options?.slice(0, 2).map((opt: any, optIdx: number) => (
                                  <span key={opt.key ?? optIdx} style={{ background: '#e0f2fe', color: '#0369a1', padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>{opt.text}</span>
                                ))}
                                <span style={{ fontSize: '0.75rem', color: '#94a3b8', marginLeft: '0.25rem' }}>+ select more</span>
                              </div>
                            ) : (
                              <input 
                                type="text" 
                                className="inspector-input" 
                                style={{ maxWidth: '100%', padding: '0.4rem 0.6rem', fontSize: '0.85rem', border: err ? '1px solid #ea580c' : '1px solid #cbd5e1' }} 
                                placeholder={item.placeholder || ''} 
                                value={val || ''}
                                onChange={(e) => setFieldValues(prev => ({ ...prev, [valKey]: e.target.value }))}
                              />
                            )}
                          </div>
                        );
                      };

                      if (!isRepeatableField) {
                        return <div key={item.id}>{renderLeafInput()}</div>;
                      }

                      // Repeatable field: render instances
                      const fieldParentInstId = item._parentInstanceId || 'root';
                      const fieldRepeatKey = `${fieldParentInstId}/${item.id}`;
                      const fieldInstances = getInstances(fieldRepeatKey, leafMeta);
                      const fieldMax = leafMeta.repeatMax ?? -1;
                      const fieldMin = leafMeta.repeatMin ?? 0;
                      const canAddField = fieldMax === -1 || fieldInstances.length < fieldMax;

                      return (
                        <div key={item.id} style={{ marginBottom: '0.75rem' }}>
                          {fieldInstances.length === 0 ? null : fieldInstances.map(instId => (
                            <div key={instId} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                              <div style={{ flex: 1 }}>{renderLeafInput(instId)}</div>
                              {fieldInstances.length > fieldMin && (
                                <button
                                  onClick={() => removeInstance(fieldRepeatKey, instId, leafMeta)}
                                  style={{
                                    background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer',
                                    fontSize: '0.8rem', padding: '0.3rem', marginTop: '1.4rem'
                                  }}
                                  onMouseOver={(e) => (e.currentTarget.style.color = '#ef4444')}
                                  onMouseOut={(e) => (e.currentTarget.style.color = '#94a3b8')}
                                  title="Entfernen"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          ))}
                          {canAddField && (
                            <button
                              onClick={() => addInstance(fieldRepeatKey, leafMeta)}
                              style={{
                                background: 'none', border: 'none', color: '#64748b', cursor: 'pointer',
                                fontSize: '0.78rem', padding: '0.25rem 0', display: 'flex', alignItems: 'center', gap: '0.3rem'
                              }}
                              onMouseOver={(e) => (e.currentTarget.style.color = '#3b82f6')}
                              onMouseOut={(e) => (e.currentTarget.style.color = '#64748b')}
                            >
                              + {item.text} hinzufügen
                            </button>
                          )}
                        </div>
                      );
                    };

                    return builderItems.filter(item => !item.parentId).map(item => renderPreviewItem(item));
                  })()}
                </div>
              </div>
            </div>

            {/* Export Preview (JSON outputs side-by-side) */}
            <div className="split-pane-right">
              <h3>Export Preview</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '1.5rem' }}>
                <div>
                  <h4 style={{ color: '#059669', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      openEHR Flat JSON 
                      {Object.keys(validationErrorsList).length > 0 && (
                        <span style={{ fontSize: '0.7rem', color: '#ea580c', background: '#fff7ed', padding: '0.1rem 0.4rem', borderRadius: '4px', fontWeight: 500 }}>
                          ⚠️ Has Validation Errors
                        </span>
                      )}
                    </span>
                    <button
                      className="btn-status-toggle"
                      style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem', height: 'auto', background: '#059669', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                      onClick={() => downloadJson(openEhrFlatJson, `${form.name}_openEHR_flat.json`)}
                    >
                      ⬇ Download
                    </button>
                  </h4>
                  <pre style={{ overflow: 'auto', maxHeight: '300px', background: '#0f172a', color: '#e2e8f0', padding: '0.75rem', borderRadius: '6px', fontSize: '0.75rem' }}>
                    {JSON.stringify(openEhrFlatJson, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Warnings Drawer */}
      {warningsOpen && (
        <div className="validation-drawer">
          <div className="validation-drawer-header">
            <span>Validation Warnings ({warnings.length})</span>
            <span style={{ cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setWarningsOpen(false)}>X</span>
          </div>
          <ul className="validation-list">
            {warnings.map((w, idx) => (
              <li key={idx} className="validation-item warning">
                ⚠️ {w}
              </li>
            ))}
            {warnings.length === 0 && <li className="validation-item" style={{ color: '#16a34a' }}>✓ All mapped fields compliant!</li>}
          </ul>
        </div>
      )}

      {/* Bottom Status Bar */}
      <footer className="workbench-bottom-bar">
        <div className="bottom-stats-left">
          <div className="bottom-stat">
            <span className="bottom-stat-label">Template fields used:</span>
            <span className="bottom-stat-value">{fieldsInForm} / {totalFields}</span>
          </div>
          <div className="bottom-stat">
            <span className="bottom-stat-label">Validation:</span>
            <span className={`bottom-stat-status ${isFormValid ? 'ok' : 'warning'}`}>
              {isFormValid ? '✓ Valid' : `⚠ ${warnings.length} warnings`}
            </span>
          </div>
        </div>
        <div className="bottom-stats-right">
          <span
            className="bottom-warnings-toggle"
            onClick={() => setWarningsOpen(!warningsOpen)}
          >
            {warningsOpen ? '✕ Close' : 'Open Validation Panel'}
          </span>
        </div>
      </footer>
    </div>
  );
}
