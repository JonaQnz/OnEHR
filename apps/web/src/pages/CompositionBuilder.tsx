import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useDrag } from 'react-dnd';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, BarChart3, FileText, GripVertical, Save, Trash2, Type } from 'lucide-react';
import {
  COMPOSITION_EXTENSION_KEY,
  COMPOSITION_SCHEMA_VERSION,
  collectRuntimeFields,
  getCompositionDefinition,
  type CompositionBlock,
  type CompositionDataBlock,
  type CompositionDefinition,
  type CompositionFormBlock,
  type CompositionLayoutElement,
  type FormDefinitionV1,
} from 'core';
import { ExtensionSlot } from '../components/FrontendPluginRegistry';
import { DesignerShell } from '../designer/DesignerShell';
import { ClinicalGrid } from '../components/layout/ClinicalLayout';
import CompositionScriptEditor from '../scripting/editor/CompositionScriptEditor';
import { CompositionBuilderCanvas } from '../designer/CompositionBuilderCanvas';
import '../styles/workbench.css';
import '../styles/builder-theme.css';

void ClinicalGrid;
void (null as unknown as CompositionFormBlock);

const API = 'http://localhost:3001/api';
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
type FormRow = { id: string; name: string; status: string; version: string };
type AqlFunction = { id: string; packageName: string; name: string; description: string; enabled: boolean };
type WidgetDefinition = { id: string; widgetId?: string; title: string; aqlFunctionId?: string; available: boolean; columns: { value: string; label?: string; time?: string }; chart: { type: 'line' | 'area' | 'bar' | 'metric' | 'table' | 'text' } };
type WidgetPackage = { id: string; label: string; available: boolean; widgets: WidgetDefinition[] };
type CompositionResponse = { id: string; name: string; canonical_json: FormDefinitionV1 };
type ChildField = { id: string; label: string; required: boolean };
type CompositionBlockKind = CompositionBlock['type'];




async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, credentials: 'include', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
  return body as T;
}

function defaultComposition(): CompositionDefinition {
  return { schemaVersion: COMPOSITION_SCHEMA_VERSION, pages: [{ id: id('page'), title: 'Seite 1', blocks: [], layout: [] }] };
}

function newCompositionBlock(kind: CompositionBlockKind, forms: FormRow[], aqlFunctions: AqlFunction[]): CompositionBlock {
  if (kind === 'form') return { id: id('form'), type: 'form', formId: forms[0]?.id || '', title: forms[0]?.name };
  if (kind === 'data') return { id: id('data'), type: 'data', title: 'Klinische Daten', aqlFunctionId: aqlFunctions[0]?.id || '', display: 'list', limit: 20 };
  return { id: id('text'), type: 'text', title: 'Hinweis', content: '' };
}

export default function CompositionBuilder() {
  const { id: compositionId } = useParams();
  const [record, setRecord] = useState<CompositionResponse | null>(null);
  const [composition, setComposition] = useState<CompositionDefinition>(defaultComposition());
  const [forms, setForms] = useState<FormRow[]>([]);
  const [aqlFunctions, setAqlFunctions] = useState<AqlFunction[]>([]);
  const [widgetPackages, setWidgetPackages] = useState<WidgetPackage[]>([]);
  const [fields, setFields] = useState<Record<string, ChildField[]>>({});
  const [activePage, setActivePage] = useState(0);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [workspace, setWorkspace] = useState<'designer' | 'script'>('designer');

  useEffect(() => {
    if (!compositionId) return;
    void Promise.all([
      request<CompositionResponse>(`/forms/${encodeURIComponent(compositionId)}`),
      request<FormRow[]>('/forms'),
      request<{ functions: AqlFunction[] }>('/functions/aql'),
      request<{ packages: WidgetPackage[] }>('/plugins/widget-packages'),
    ]).then(([form, allForms, functions, packages]) => {
      const value = getCompositionDefinition(form.canonical_json.extensions) || defaultComposition();
      setRecord(form); setComposition(value); setForms(allForms.filter((candidate) => candidate.id !== form.id && candidate.status === 'published'));
      setAqlFunctions((functions.functions || []).filter((candidate) => candidate.enabled));
      setWidgetPackages((packages.packages || []).filter((candidate) => candidate.available));
      value.pages.flatMap((page) => page.blocks).forEach((block) => { if (block.type === 'form') void loadFields(block.formId); });
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Composition konnte nicht geladen werden.'));
  }, [compositionId]);

  const loadFields = async (formId: string) => {
    if (!formId || fields[formId]) return;
    try {
      const form = await request<CompositionResponse>(`/forms/${encodeURIComponent(formId)}`);
      setFields((current) => ({ ...current, [formId]: collectRuntimeFields(form.canonical_json).map((field) => ({ id: field.id, label: field.label, required: field.required })) }));
    } catch { setFields((current) => ({ ...current, [formId]: [] })); }
  };

  const page = composition.pages[activePage];
  // Widget packages are available by default.  A stored list means the author
  // deliberately narrowed that default; an absent list is not an empty list.
  const enabledWidgetPackageIds = composition.widgetPackageIds ?? widgetPackages.map((widgetPackage) => widgetPackage.id);
  const selectedLayout = page?.layout.find((entry) => entry.id === selectedBlockId);
  const selectedBlock = selectedLayout?.blockId ? page?.blocks.find((block) => block.id === selectedLayout.blockId) : undefined;
  const updatePage = (pageIndex: number, patch: Partial<CompositionDefinition['pages'][number]>) => setComposition((current) => ({ ...current, pages: current.pages.map((candidate, index) => index === pageIndex ? { ...candidate, ...patch } : candidate) }));
  const updateBlock = (blockId: string, patch: Partial<CompositionBlock>) => setComposition((current) => ({ ...current, pages: current.pages.map((candidate) => ({ ...candidate, blocks: candidate.blocks.map((block) => block.id === blockId ? { ...block, ...patch } as CompositionBlock : block) })) }));
  const removeBlock = (blockId: string) => setComposition((current) => ({ ...current, pages: current.pages.map((candidate) => ({ ...candidate, blocks: candidate.blocks.filter((block) => block.id !== blockId) })) }));
  const addBlock = (block: CompositionBlock, layoutId = id('layout')) => setComposition((current) => ({ ...current, pages: current.pages.map((candidate, index) => index === activePage ? { ...candidate, blocks: [...candidate.blocks, block], layout: [...candidate.layout, { id: layoutId, element: 'block', blockId: block.id }] } : candidate) }));
  const updateLayout = (layoutId: string, patch: Partial<CompositionLayoutElement>) => setComposition((current) => ({ ...current, pages: current.pages.map((candidate) => ({ ...candidate, layout: candidate.layout.map((entry) => entry.id === layoutId ? { ...entry, ...patch } : entry) })) }));
  const removePage = (pageId: string) => setComposition((current) => {
    if (current.pages.length === 1) return current;
    const nextPages = current.pages.filter((candidate) => candidate.id !== pageId);
    setActivePage((currentIndex) => Math.min(currentIndex, nextPages.length - 1));
    setSelectedBlockId(null);
    return { ...current, pages: nextPages };
  });
  const addPage = () => {
    const next = { id: id('page'), title: `Seite ${composition.pages.length + 1}`, blocks: [] as CompositionBlock[], layout: [] as CompositionLayoutElement[] };
    setComposition((current) => ({ ...current, pages: [...current.pages, next] }));
    setActivePage(composition.pages.length);
    setSelectedBlockId(null);
  };

  void removeBlock;

  const save = async () => {
    if (!record || !compositionId) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const canonical = { ...record.canonical_json, name: record.name, extensions: { ...record.canonical_json.extensions, [COMPOSITION_EXTENSION_KEY]: composition } };
      const updated = await request<CompositionResponse>(`/forms/${encodeURIComponent(compositionId)}`, { method: 'PUT', body: JSON.stringify(canonical) });
      setRecord(updated); setNotice('Composition gespeichert. Veröffentliche sie wie ein normales Formular im Dashboard.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Speichern fehlgeschlagen.'); }
    finally { setSaving(false); }
  };

  if (error && !record) return <div style={{ padding: '2rem', color: '#b91c1c' }}>{error}</div>;
  if (!record || !page) return <div style={{ padding: '2rem' }}>Composition wird geladen…</div>;

  return <DesignerShell kind="composition" dragAndDrop><div style={{ minHeight: '100vh', background: '#f8fafc', color: '#0f172a' }}>
    <header style={{ height: 62, background: '#fff', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 1.25rem', position: 'sticky', top: 0, zIndex: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.8rem' }}><Link to="/" style={{ color: '#475569' }}><ArrowLeft size={19} /></Link><div><strong>{record.name}</strong><span style={{ marginLeft: '.6rem', fontSize: '.75rem', color: '#64748b' }}>COMPOSITION</span></div></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.8rem' }}><ExtensionSlot name="designer:toolbar" context={{ documentId: record.id, kind: 'composition' }} />{notice && <span style={{ color: '#166534', fontSize: '.82rem' }}>{notice}</span>}{error && <span style={{ color: '#b91c1c', fontSize: '.82rem' }}>{error}</span>}<button className="btn btn-secondary" onClick={() => setWorkspace(workspace === 'designer' ? 'script' : 'designer')}>{workspace === 'designer' ? 'Script' : 'Designer'}</button><button className="btn" onClick={() => void save()} disabled={saving}><Save size={16} /> {saving ? 'Speichert…' : 'Speichern'}</button></div>
    </header>
    {workspace === 'script' ? <CompositionScriptEditor compositionId={record.id} definition={record.canonical_json} onClose={() => setWorkspace('designer')} onSaved={(updated) => setRecord((current) => current ? { ...current, canonical_json: updated.canonical_json } : current)} /> : <div className="workbench-panels" style={{ minHeight: 'calc(100vh - 62px)' }}>
      <div className="workbench-panel left">
        <div className="panel-content" style={{ padding: '1rem' }}>
          <CompositionToolbox forms={forms} functions={aqlFunctions} widgetPackages={widgetPackages} enabledWidgetPackageIds={enabledWidgetPackageIds} onAdd={(block) => { const layoutId = id('layout'); addBlock(block, layoutId); setSelectedBlockId(layoutId); }} />
          <ExtensionSlot name="designer:toolbox" context={{ documentId: record.id, kind: 'composition', activePageId: page.id }} />
        </div>
      </div>
      <div className="workbench-panel center">
        <div className="canvas-scroll-container" onClick={(e) => { if (!(e.target as HTMLElement).closest('.SortableItem') && !(e.target as HTMLElement).closest('.form-input')) setSelectedBlockId(null); }}>
          <div style={{ maxWidth: 1050, width: '100%', margin: '0 auto', padding: '2rem' }}>
        <input value={page.title} onChange={(event) => updatePage(activePage, { title: event.target.value })} style={{ width: '100%', border: 0, borderBottom: '1px solid #cbd5e1', background: 'transparent', fontSize: '1.55rem', fontWeight: 700, padding: '.35rem 0', marginBottom: '.45rem' }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '.75rem', alignItems: 'end', marginBottom: '1.25rem' }}><textarea value={page.description || ''} onChange={(event) => updatePage(activePage, { description: event.target.value || undefined })} placeholder="Kurze Einordnung für diese Seite (optional)" className="form-input" style={{ minHeight: '52px' }} /></div>
        <CompositionBuilderCanvas definition={composition} activePageId={page.id} onChange={(next) => { setComposition(next); const nextPageIndex = next.pages.findIndex((candidate) => candidate.id === page.id); setActivePage(nextPageIndex >= 0 ? nextPageIndex : 0); }} onSelect={setSelectedBlockId} />
        <ExtensionSlot name="designer:canvas" context={{ documentId: record.id, kind: 'composition', activePageId: page.id, selectedBlockId }} />
          </div>
        </div>
      </div>
      <div className="workbench-panel right">
        <div className="panel-content" style={{ padding: '1rem' }}>
        {!selectedBlockId && <div style={{ paddingBottom: '1rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#2563eb', marginBottom: '.65rem' }}>COMPOSITION-EIGENSCHAFTEN</div>
          <label className="form-label">Name der Composition<input className="form-input" value={record.name} onChange={(event) => setRecord((current) => current ? { ...current, name: event.target.value } : current)} /></label>
          <label className="form-label">Aktive Seite<select className="form-input" value={page.id} onChange={(event) => { const index = composition.pages.findIndex((candidate) => candidate.id === event.target.value); if (index >= 0) setActivePage(index); }}><option value="">Seite wählen…</option>{composition.pages.map((candidate, index) => <option key={candidate.id} value={candidate.id}>{index + 1}. {candidate.title}</option>)}</select></label>
          <label className="form-label">Seitentitel<input className="form-input" value={page.title} onChange={(event) => updatePage(activePage, { title: event.target.value })} /></label>
          <label className="form-label">Seitenbeschreibung<textarea className="form-input" style={{ minHeight: 72 }} value={page.description || ''} onChange={(event) => updatePage(activePage, { description: event.target.value || undefined })} /></label>
          <label className="form-label">Spalten dieser Seite<select className="form-input" value={page.columns || 1} onChange={(event) => updatePage(activePage, { columns: Number(event.target.value) as 1 | 2 | 3 })}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>
          <label className="form-label">Ansicht im Vorgang<select className="form-input" value={composition.viewMode || 'tabs'} onChange={(event) => setComposition((current) => ({ ...current, viewMode: event.target.value === 'stacked' ? 'stacked' : undefined }))}><option value="tabs">Tabs (eine Seite sichtbar)</option><option value="stacked">Gestapelt (alle Seiten untereinander)</option></select></label>
          <p style={{ color: '#64748b', fontSize: '.76rem', margin: '.2rem 0 0' }}>Voreinstellung für neue Aufrufe - kann im laufenden Vorgang jederzeit umgeschaltet werden.</p>
          <label className="form-label" style={{ marginTop: '.7rem' }}>Gemeinsames Speichern<select className="form-input" value={composition.requireAtomicCommit === undefined ? '' : String(composition.requireAtomicCommit)} onChange={(event) => setComposition((current) => ({ ...current, requireAtomicCommit: event.target.value === '' ? undefined : event.target.value === 'true' }))}><option value="">Standard (aus Backend-Einstellung)</option><option value="true">Immer atomar - blockieren, falls nicht möglich</option><option value="false">Bestmöglich - auch nacheinander speichern erlauben</option></select></label>
          <p style={{ color: '#64748b', fontSize: '.76rem', margin: '.2rem 0 0' }}>"Alle Änderungen speichern" versucht immer zuerst eine echte, atomare openEHR Contribution. "Immer atomar" blockiert das Speichern vollständig, falls der aktive Provider das nicht unterstützt. "Bestmöglich" speichert dann stattdessen jedes Formular einzeln nacheinander (nie als Erfolg gemeldet, falls nicht alle gespeichert werden konnten).</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.55rem', marginTop: '.7rem' }}><button className="btn btn-secondary" onClick={addPage}>Neue Seite</button><button className="btn btn-secondary" style={{ color: '#b91c1c' }} onClick={() => removePage(page.id)} disabled={composition.pages.length === 1}><Trash2 size={15} /> Seite löschen</button></div>
          <p style={{ color: '#64748b', fontSize: '.78rem', lineHeight: 1.4, margin: '.8rem 0 0' }}>Klicke ein Canvas-Element an, um ausschließlich dessen Feld-, Formular- oder Layout-Eigenschaften zu bearbeiten.</p>
        </div>}
        {!selectedBlockId && <>
        <div style={{ paddingBottom: '1rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#2563eb', marginBottom: '.65rem' }}>WIDGET-PAKETE</div>
          <p style={{ color: '#64748b', fontSize: '.78rem', lineHeight: 1.4, margin: '0 0 .7rem' }}>Aktivierte Pakete erscheinen links als ziehbare Datenkarten. Jedes Widget verlangt einen Patientenkontext mit EHR-ID.</p>
          {widgetPackages.length === 0 ? <div style={{ color: '#64748b', fontSize: '.8rem' }}>Keine verfügbaren Widget-Pakete. Aktiviere ein Plugin und hinterlege seine AQL-Funktionen.</div> : <div style={{ display: 'grid', gap: '.45rem' }}>{widgetPackages.map((widgetPackage) => { const enabled = enabledWidgetPackageIds.includes(widgetPackage.id); return <label key={widgetPackage.id} style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start', fontSize: '.82rem' }}><input type="checkbox" checked={enabled} onChange={(event) => setComposition((current) => { const currentlyEnabled = current.widgetPackageIds ?? widgetPackages.map((item) => item.id); return { ...current, widgetPackageIds: event.target.checked ? [...new Set([...currentlyEnabled, widgetPackage.id])] : currentlyEnabled.filter((item) => item !== widgetPackage.id) }; })} /><span><strong>{widgetPackage.label}</strong><small style={{ display: 'block', color: '#64748b' }}>{widgetPackage.widgets.filter((widget) => widget.available).length} Datenkarten</small></span></label>; })}</div>}
        </div>
        </>}
        {selectedLayout && !selectedBlock && <div style={{ paddingBottom: '1rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#2563eb', marginBottom: '.65rem' }}>LAYOUT-EIGENSCHAFTEN</div>
          <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: '.7rem' }}>{selectedLayout.element}</strong>
          {['Header', 'Label', 'Paragraph', 'HyperLink'].includes(selectedLayout.element) && <label className="form-label">Beschriftung<input className="form-input" value={selectedLayout.label || ''} onChange={(event) => updateLayout(selectedLayout.id, { label: event.target.value || undefined })} /></label>}
          {['Header', 'Paragraph'].includes(selectedLayout.element) && <label className="form-label">Inhalt<textarea className="form-input" style={{ minHeight: '84px' }} value={selectedLayout.content || ''} onChange={(event) => updateLayout(selectedLayout.id, { content: event.target.value || undefined })} /></label>}
          {selectedLayout.element === 'FieldSet' && <p style={{ fontSize: '.8rem', color: '#64748b', lineHeight: 1.4 }}>Container nehmen Formular-, Daten- und Darstellungselemente auf. Ziehe Elemente direkt in den Container.</p>}
          {selectedLayout.element === 'TwoColumnRow' && <p style={{ fontSize: '.8rem', color: '#64748b', lineHeight: 1.4 }}>Zweispaltige Zeile. Ziehe Blöcke in die gewünschte Spalte.</p>}
          {selectedLayout.element === 'ThreeColumnRow' && <p style={{ fontSize: '.8rem', color: '#64748b', lineHeight: 1.4 }}>Dreispaltige Zeile. Ziehe Blöcke in die gewünschte Spalte.</p>}
        </div>}
        {selectedBlock?.type === 'form' && <div style={{ paddingBottom: '1rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#2563eb', marginBottom: '.65rem' }}>FORMULAR-EIGENSCHAFTEN</div>
          <strong style={{ display: 'block', fontSize: '.92rem', marginBottom: '.3rem' }}>{forms.find((form) => form.id === selectedBlock.formId)?.name || 'Formular auswählen'}</strong>
          <label className="form-label">Veröffentlichtes Formular<select className="form-input" value={selectedBlock.formId} onChange={(event) => { const formId = event.target.value; updateBlock(selectedBlock.id, { formId, title: forms.find((form) => form.id === formId)?.name }); if (formId) void loadFields(formId); }}><option value="">Formular auswählen…</option>{forms.map((form) => <option key={form.id} value={form.id}>{form.name} · v{form.version}</option>)}</select></label>
          <p style={{ fontSize: '.78rem', color: '#64748b', lineHeight: 1.4, margin: '0 0 .8rem' }}>Der Composition-Modus wird an dieses Formular vererbt. Pflichtfelder sind geschützt und können nicht ausgeblendet werden.</p>
          <label className="form-label">Anzeigetitel<input className="form-input" value={selectedBlock.title || ''} onChange={(event) => updateBlock(selectedBlock.id, { title: event.target.value || undefined })} /></label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.75rem' }}>
            <label className="form-label">Darstellung (Höhe)<select className="form-input" value={selectedBlock.displayMode || 'auto'} onChange={(event) => updateBlock(selectedBlock.id, { displayMode: event.target.value as 'auto' | 'fixed' })}><option value="auto">Auto-Resize (100%)</option><option value="fixed">Fixe Höhe (Scroll)</option></select></label>
            <label className="form-label">Daten vorausfüllen<select className="form-input" value={selectedBlock.load || 'never'} onChange={(event) => updateBlock(selectedBlock.id, { load: event.target.value as 'never' | 'provider' })}><option value="never">Nicht vorausfüllen</option><option value="provider">Aus EHR/KIS laden</option></select></label>
          </div>
          <div style={{ marginTop: '.85rem' }}><span className="form-label">Optionale Felder</span>{(fields[selectedBlock.formId] || []).length === 0 ? <div style={{ fontSize: '.8rem', color: '#64748b' }}>Wähle ein veröffentlichtes Formular, um dessen Felder zu konfigurieren.</div> : <div style={{ display: 'grid', gap: '.35rem', maxHeight: 290, overflowY: 'auto', paddingRight: '.2rem' }}>{(fields[selectedBlock.formId] || []).map((field) => { const hidden = (selectedBlock.hiddenFieldIds || []).includes(field.id); return <label key={field.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '.45rem', fontSize: '.8rem', opacity: field.required ? .52 : 1, padding: '.32rem .2rem' }}><input type="checkbox" disabled={field.required} checked={!hidden} onChange={(event) => updateBlock(selectedBlock.id, { hiddenFieldIds: event.target.checked ? (selectedBlock.hiddenFieldIds || []).filter((id) => id !== field.id) : [...(selectedBlock.hiddenFieldIds || []), field.id] })} /><span><strong style={{ fontWeight: 600 }}>{field.label}</strong>{field.required && <span style={{ color: '#b91c1c' }}> · Pflichtfeld</span>}<small style={{ display: 'block', color: '#64748b', marginTop: 1 }}>{eventLabel(hidden)}</small></span></label>; })}</div>}</div>
        </div>}
        {selectedBlock?.type === 'data' && <div style={{ paddingBottom: '1rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0' }}><div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#2563eb', marginBottom: '.65rem' }}>DATENKARTEN-EIGENSCHAFTEN</div><label className="form-label">Titel<input className="form-input" value={selectedBlock.title} onChange={(event) => updateBlock(selectedBlock.id, { title: event.target.value })} /></label></div>}
        {selectedBlock?.type === 'text' && <div style={{ paddingBottom: '1rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0' }}><div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#2563eb', marginBottom: '.65rem' }}>TEXT-EIGENSCHAFTEN</div><label className="form-label">Titel<input className="form-input" value={selectedBlock.title || ''} onChange={(event) => updateBlock(selectedBlock.id, { title: event.target.value || undefined })} /></label><label className="form-label">Inhalt<textarea className="form-input" style={{ minHeight: 120 }} value={selectedBlock.content} onChange={(event) => updateBlock(selectedBlock.id, { content: event.target.value })} /></label></div>}
        {selectedBlock && <div style={{ paddingBottom: '1rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#64748b', marginBottom: '.65rem' }}>LAYOUT</div>
          <label className="form-label">Blockbreite<select className="form-input" value={Math.min(selectedBlock.column || 1, page.columns || 1)} onChange={(event) => updateBlock(selectedBlock.id, { column: Number(event.target.value) as 1 | 2 | 3 })}>{Array.from({ length: page.columns || 1 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} {index === 0 ? 'Spalte' : 'Spalten'}</option>)}</select></label>
          <p style={{ color: '#64748b', fontSize: '.78rem', lineHeight: 1.4, margin: '.55rem 0 0' }}>Die Blockbreite wird innerhalb des Seitenlayouts angewendet. Ziehe den Griff, um die Reihenfolge sicher zu ändern.</p>
        </div>}
        {composition.pages.some((candidate) => candidate.id === selectedBlockId) && <div style={{ paddingBottom: '1rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0' }}><div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#64748b', marginBottom: '.65rem' }}>SEITEN-EIGENSCHAFTEN</div><p style={{ color: '#64748b', fontSize: '.78rem', margin: '.5rem 0 0' }}>Seiten sind native Gruppencontainer des FormBuilders. Ziehe Zeilen und Blöcke direkt hinein.</p><button className="btn btn-secondary" style={{ width: '100%', marginTop: '.8rem', color: '#b91c1c' }} onClick={() => removePage(page.id)} disabled={composition.pages.length === 1}><Trash2 size={15} /> Seite löschen</button></div>}
        <ExtensionSlot name="designer:inspector" context={{ documentId: record.id, kind: 'composition', activePageId: page.id, selectedBlockId }} />
        </div>
      </div>
    </div>}
  </div></DesignerShell>;
}

function eventLabel(hidden: boolean): string { return hidden ? 'ausgeblendet' : 'sichtbar'; }

function CompositionToolbox({ forms, functions, widgetPackages, enabledWidgetPackageIds, onAdd }: { forms: FormRow[]; functions: AqlFunction[]; widgetPackages: WidgetPackage[]; enabledWidgetPackageIds: string[]; onAdd: (block: CompositionBlock) => void }) {
  return <><div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#64748b', marginBottom: '.75rem' }}>COMPOSITION</div><div style={{ display: 'grid', gap: '.6rem' }}>{forms.length > 0 ? <CompositionToolboxItem createBlock={() => newCompositionBlock('form', forms, functions)} label="Ganzes Formular" icon={<FileText size={16} />} onAdd={onAdd} /> : <div style={{ padding: '.65rem .7rem', border: '1px dashed #f59e0b', borderRadius: 6, color: '#92400e', fontSize: '.78rem', lineHeight: 1.4 }}>Keine veröffentlichten Formulare verfügbar.</div>}<CompositionToolboxItem createBlock={() => newCompositionBlock('text', forms, functions)} label="Text / Hinweis" icon={<Type size={16} />} onAdd={onAdd} /></div>{forms.length === 0 && <p style={{ color: '#b45309', fontSize: '.78rem', lineHeight: 1.4 }}>Veröffentliche zuerst ein Formular, bevor du es in diese Composition ziehst.</p>}<WidgetPackageToolbox packages={widgetPackages.filter((widgetPackage) => enabledWidgetPackageIds.includes(widgetPackage.id))} onAdd={onAdd} /><div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#64748b', margin: '1.1rem 0 .75rem' }}>LAYOUT DER AKTIVEN SEITE</div><div style={{ display: 'grid', gap: '.6rem' }}><BuilderLayoutItem label="Gruppe / Container" element="FieldSet" /><BuilderLayoutItem label="2 Spalten" element="TwoColumnRow" /><BuilderLayoutItem label="3 Spalten" element="ThreeColumnRow" /><BuilderLayoutItem label="Überschrift" element="Header" staticItem content="Abschnitt" /><BuilderLayoutItem label="Label" element="Label" staticItem content="Beschriftung" /><BuilderLayoutItem label="Absatz / Text" element="Paragraph" staticItem content="Beschreibung" /><BuilderLayoutItem label="Trennlinie" element="LineBreak" staticItem /><BuilderLayoutItem label="Aktion / Button" element="HyperLink" /></div></>;
}

function WidgetPackageToolbox({ packages, onAdd }: { packages: WidgetPackage[]; onAdd: (block: CompositionBlock) => void }) {
  const widgets = packages.flatMap((widgetPackage) => widgetPackage.widgets.filter((widget) => widget.available).map((widget) => ({ widgetPackage, widget })));
  if (widgets.length === 0) return null;
  return <><div style={{ fontSize: '.74rem', fontWeight: 800, letterSpacing: '.08em', color: '#64748b', margin: '1.1rem 0 .75rem' }}>DATENKARTEN</div><div style={{ display: 'grid', gap: '.6rem' }}>{widgets.map(({ widgetPackage, widget }) => { const block: CompositionDataBlock = { id: id('data'), type: 'data', title: widget.title, widgetPackageId: widgetPackage.id, ...(widget.widgetId ? { widgetId: widget.widgetId } : { aqlFunctionId: widget.aqlFunctionId || '' }), display: widget.chart.type === 'metric' ? 'metric' : widget.chart.type === 'text' ? 'text' : widget.chart.type === 'table' ? 'list' : 'trend', ...(widget.chart.type === 'line' || widget.chart.type === 'area' || widget.chart.type === 'bar' ? { chartType: widget.chart.type } : {}), valueColumn: widget.columns.value, ...(widget.columns.label ? { labelColumn: widget.columns.label } : {}), ...(widget.columns.time ? { timeColumn: widget.columns.time } : {}), limit: 100 }; return <CompositionToolboxBlockItem key={`${widgetPackage.id}/${widget.id}`} block={block} label={widget.title} icon={<BarChart3 size={16} />} onAdd={onAdd} />; })}</div></>;
}

function compositionBuilderItem(block: CompositionBlock): Record<string, unknown> {
  // react-form-builder2 treats a toolbox entry as new only when data.id is empty.
  // The old implementation populated it with the clinical block id, causing
  // container drops to be treated as a move from a non-existent canvas node.
  return {
    element: 'CustomElement', key: 'composition-block', custom: true, bare: true,
    label: block.title || (block.type === 'form' ? 'Formular' : block.type === 'data' ? 'Datenkarte' : 'Hinweis'),
    text: block.title || block.type, field_name: block.id,
    custom_metadata: { compositionBlock: block },
  };
}

function CompositionToolboxBlockItem({ block, label, icon, onAdd }: { block: CompositionBlock; label: string; icon: ReactNode; onAdd: (block: CompositionBlock) => void }) {
  const [{ isDragging }, drag] = useDrag(() => ({ type: 'card', item: () => ({ id: `toolbox/${block.id}`, index: -1, data: compositionBuilderItem(block), onCreate: (data: any) => ({ ...data, id: id('layout'), field_name: block.id }) }), collect: (monitor) => ({ isDragging: monitor.isDragging() }) }), [block]);
  return <button ref={drag} className="btn btn-secondary" style={{ opacity: isDragging ? .5 : 1, cursor: 'grab', justifyContent: 'flex-start' }} onClick={() => onAdd(block)}><GripVertical size={15} />{icon} {label}</button>;
}

function CompositionToolboxItem({ createBlock, label, icon, onAdd }: { createBlock: () => CompositionBlock; label: string; icon: ReactNode; onAdd: (block: CompositionBlock) => void }) {
  // The dragged and clicked variants intentionally use the same factory. The
  // previous drag path created an empty formId, which made a Composition fail
  // canonical validation on save although clicking the same button worked.
  const block = createBlock();
  return <CompositionToolboxBlockItem block={block} label={label} icon={icon} onAdd={() => onAdd(block)} />;
}

function BuilderLayoutItem({ label, element, page = false, staticItem = false, content = '' }: { label: string; element: string; page?: boolean; staticItem?: boolean; content?: string }) { const [{ isDragging }, drag] = useDrag(() => ({ type: 'card', item: () => ({ id: id('layout'), index: -1, data: { element, label, text: label, static: staticItem, content, isContainer: ['FieldSet', 'TwoColumnRow', 'ThreeColumnRow'].includes(element), childItems: element === 'TwoColumnRow' ? [null, null] : element === 'ThreeColumnRow' ? [null, null, null] : element === 'FieldSet' ? [null] : undefined, custom_metadata: page ? { compositionPage: true, columns: 1 } : element === 'HyperLink' ? { type: 'button' } : {} }, onCreate: (data: any) => ({ ...data, id: id(page ? 'page' : 'layout'), field_name: id('layout') }) }), collect: (monitor) => ({ isDragging: monitor.isDragging() }) }), [element, page, staticItem, content]); return <button ref={drag} className="btn btn-secondary" style={{ opacity: isDragging ? .5 : 1, cursor: 'grab', justifyContent: 'flex-start' }}><GripVertical size={15} />{label}</button>; }

