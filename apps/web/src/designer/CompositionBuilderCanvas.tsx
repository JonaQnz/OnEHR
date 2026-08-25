import { useEffect, useMemo } from 'react';
import { useDrop } from 'react-dnd';
import FormBuilders, { ReactFormBuilder } from 'react-form-builder2';
import 'react-form-builder2/dist/app.css';
import { insertCompositionBlock, type CompositionBlock, type CompositionDefinition, type CompositionLayoutElement } from 'core';

type BuilderItem = Record<string, any>;
const BlockCard = ({ data, onSelect }: { data: BuilderItem; onSelect?: () => void }) => {
  const block = data.custom_metadata?.compositionBlock as CompositionBlock | undefined;
  const label = block?.type === 'form' ? 'Formular' : block?.type === 'data' ? 'Datenkarte' : 'Hinweis';
  const openProperties = (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); onSelect?.(); };
  return <article onClick={openProperties} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '.7rem', textAlign: 'left', padding: '.65rem .8rem', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer' }}>
    <div style={{ minWidth: 0, flex: 1 }}><strong>{label}</strong><span style={{ marginLeft: '.5rem', color: '#64748b' }}>{data.label || block?.title || 'Unbenannt'}</span></div>
    <button type="button" onClick={openProperties} style={{ flex: '0 0 auto', border: '1px solid #93c5fd', borderRadius: 5, background: '#eff6ff', color: '#1d4ed8', padding: '.25rem .45rem', fontSize: '.75rem', cursor: 'pointer' }}>Eigenschaften</button>
  </article>;
};

function register() { try { FormBuilders.Registry.register('composition-block', BlockCard as any); } catch {} }
/** The active page is intentionally not a Form Builder element. Pages belong to
 * the Composition model; the builder canvas starts empty and contains only the
 * page's actual layout and clinical blocks. */
function toBuilder(definition: CompositionDefinition, activePageId: string, onSelect: (id: string | null) => void): BuilderItem[] {
  const items: BuilderItem[] = [];
  const page = definition.pages.find((candidate) => candidate.id === activePageId);
  if (!page) return items;
  const blocks = new Map(page.blocks.map((block) => [block.id, block]));
  for (const entry of page.layout) {
    const block = entry.blockId ? blocks.get(entry.blockId) : undefined;
    if (entry.element === 'block' && !block) continue;
    if (block) {
      items.push({ id: entry.id, ...(entry.parentId ? { parentId: entry.parentId } : {}), ...(entry.column ? { col: entry.column - 1 } : {}), element: 'CustomElement', key: 'composition-block', component: BlockCard, custom: true, bare: true, label: block.title || (block.type === 'form' ? 'Formular' : block.type === 'data' ? 'Klinische Daten' : 'Hinweis'), text: block.title || block.type, field_name: block.id, props: { onSelect: () => onSelect(entry.id) }, custom_metadata: { compositionBlock: block } });
    } else {
      items.push({ id: entry.id, ...(entry.parentId ? { parentId: entry.parentId } : {}), ...(entry.column ? { col: entry.column - 1 } : {}), element: entry.element, label: entry.label || '', text: entry.content || entry.label || '', field_name: entry.id, isContainer: ['FieldSet', 'TwoColumnRow', 'ThreeColumnRow'].includes(entry.element), childItems: ['FieldSet', 'TwoColumnRow', 'ThreeColumnRow'].includes(entry.element) ? [null] : undefined, custom_metadata: { compositionLayout: true } });
    }
  }
  return items;
}
function fromBuilder(items: BuilderItem[], previous: CompositionDefinition, activePageId: string): CompositionDefinition {
  const old = previous.pages.find((page) => page.id === activePageId);
  if (!old) return previous;
  const canvasItems = items.filter(Boolean);
  const blocks = canvasItems.filter((candidate) => candidate.custom_metadata?.compositionBlock).map((candidate) => ({ ...candidate.custom_metadata.compositionBlock, title: candidate.label || candidate.custom_metadata.compositionBlock.title } as CompositionBlock));
  const layout = canvasItems.map((candidate): CompositionLayoutElement => {
    const block = candidate.custom_metadata?.compositionBlock as CompositionBlock | undefined;
    return { id: candidate.id, element: block ? 'block' : candidate.element as CompositionLayoutElement['element'], ...(candidate.label ? { label: candidate.label } : {}), ...(candidate.content || candidate.text ? { content: candidate.content || candidate.text } : {}), ...(candidate.parentId ? { parentId: candidate.parentId } : {}), ...(candidate.col !== undefined ? { column: Math.min(3, Math.max(1, Number(candidate.col) + 1)) as 1 | 2 | 3 } : {}), ...(block ? { blockId: block.id } : {}) };
  });
  const page = { ...old, blocks, layout };
  return { ...previous, pages: previous.pages.map((candidate) => candidate.id === activePageId ? page : candidate) };
}

export function CompositionBuilderCanvas({ definition, activePageId, onChange, onSelect }: { definition: CompositionDefinition; activePageId: string; onChange(next: CompositionDefinition): void; onSelect(id: string | null): void }) {
  useEffect(register, []);
  const data = useMemo(() => toBuilder(definition, activePageId, onSelect), [definition, activePageId, onSelect]);
  const Builder = ReactFormBuilder as unknown as React.ComponentType<Record<string, unknown>>;
  const [{ isOver }, drop] = useDrop(() => ({
    accept: 'card',
    drop: (item: any, monitor) => {
      if (monitor.didDrop()) return undefined;
      const page = definition.pages.find((candidate) => candidate.id === activePageId);
      if (!page || !item?.data) return undefined;
      const block = item.data.custom_metadata?.compositionBlock as CompositionBlock | undefined;
      if (block) {
        // Directly dropping a clinical block on the blank page is a valid root
        // insertion. Nested containers keep handling their own drops.
        onChange(insertCompositionBlock(definition, page.id, block, page.blocks.length));
        onSelect(`layout/${page.id}/${block.id}`);
        return { destination: 'composition-canvas' };
      }
      const created = typeof item.onCreate === 'function' ? item.onCreate(item.data) : item.data;
      const element = created?.element as CompositionLayoutElement['element'] | undefined;
      if (!created?.id || !element || !['FieldSet', 'TwoColumnRow', 'ThreeColumnRow', 'Header', 'Label', 'Paragraph', 'LineBreak', 'HyperLink'].includes(element)) return undefined;
      onChange({ ...definition, pages: definition.pages.map((candidate) => candidate.id === page.id ? { ...candidate, layout: [...candidate.layout, { id: created.id, element, ...(created.label ? { label: created.label } : {}), ...(created.content || created.text ? { content: created.content || created.text } : {}) }] } : candidate) });
      onSelect(created.id);
      return { destination: 'composition-canvas' };
    },
    collect: (monitor) => ({ isOver: monitor.isOver({ shallow: true }) }),
  }), [definition, activePageId, onChange, onSelect]);
  return <div ref={drop} className="composition-builder-canvas" style={{ outline: isOver ? '2px solid #60a5fa' : undefined, outlineOffset: 6, minHeight: 180 }}><Builder key={`builder:${activePageId}`} data={data} onLoad={async () => data} onPost={(post: unknown) => onChange(fromBuilder(Array.isArray(post) ? post as BuilderItem[] : ((post as any)?.task_data || data), definition, activePageId))} hideToolbar wrapDnd={false} renderEditForm={(props: any) => { onSelect(props.element?.id || null); return null; }} files={[]} /></div>;
}
