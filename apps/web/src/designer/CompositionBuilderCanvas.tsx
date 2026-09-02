import { useEffect, useMemo, useState } from 'react';
import { useDrop } from 'react-dnd';
import FormBuilders, { ReactFormBuilder } from 'react-form-builder2';
import 'react-form-builder2/dist/app.css';
import { insertCompositionBlock, type CompositionBlock, type CompositionDefinition, type CompositionLayoutElement } from 'core';

type BuilderItem = Record<string, any>;
const BlockCard = ({ data, onSelect }: { data: BuilderItem; onSelect?: () => void }) => {
  const block = data.custom_metadata?.compositionBlock as CompositionBlock | undefined;
  const label = block?.type === 'form' ? 'Formular' : block?.type === 'data' ? 'Datenkarte' : 'Hinweis';
  const openProperties = (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); onSelect?.(); };
  // boxSizing: 'border-box' is load-bearing here, not decorative - with the
  // default content-box, `width: 100%` + horizontal padding renders wider
  // than the SortableItem wrapper (which clips via overflow-x: hidden),
  // clipping off exactly the padding's worth of the right edge every time -
  // which is where the "Eigenschaften" button lives. That's what made it
  // look clickable but not respond: part of its hit area was being clipped
  // away, not that the click handler was broken.
  return <article onClick={openProperties} style={{ width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '.7rem', textAlign: 'left', padding: '.65rem .8rem', border: '1px solid #cbd5e1', borderRadius: 6, background: '#fff', cursor: 'pointer' }}>
    <div style={{ minWidth: 0, flex: 1 }}><strong>{label}</strong><span style={{ marginLeft: '.5rem', color: '#64748b' }}>{data.label || block?.title || 'Unbenannt'}</span></div>
    <button type="button" onClick={openProperties} style={{ flex: '0 0 auto', border: '1px solid #93c5fd', borderRadius: 5, background: '#eff6ff', color: '#1d4ed8', padding: '.25rem .45rem', fontSize: '.75rem', cursor: 'pointer' }}>Eigenschaften</button>
  </article>;
};

function register() { try { FormBuilders.Registry.register('composition-block', BlockCard as any); } catch {} }

/** Minimum column-slot count per container element type - TwoColumnRow and
 * ThreeColumnRow are fixed-width; FieldSet is a single growable column (it
 * adds its own extra slot on drop, see FieldSet.jsx's addNewChild). */
const CONTAINER_MIN_SLOTS: Record<string, number> = { TwoColumnRow: 2, ThreeColumnRow: 3, FieldSet: 1 };

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
      items.push({ id: entry.id, ...(entry.parentId ? { parentId: entry.parentId } : {}), ...(entry.column ? { col: entry.column - 1 } : {}), element: entry.element, label: entry.label || '', text: entry.content || entry.label || '', field_name: entry.id, isContainer: entry.element in CONTAINER_MIN_SLOTS, custom_metadata: { compositionLayout: true } });
    }
  }
  // Second pass: seed each container's childItems from its actual children's
  // own (parentId, col) - the only source of truth for "who sits in which
  // slot" (react-form-builder2's MultiColumnRow/FieldSet only self-heal an
  // ABSENT childItems array, never a wrong-length one - confirmed live: a
  // bare `[null]` seed for every container type, regardless of how many
  // columns it actually has, made TwoColumnRow/ThreeColumnRow render only
  // ONE empty slot instead of two/three). A container with no children yet
  // still gets its minimum slot count so it renders empty dropzones instead
  // of collapsing to nothing; one with existing children keeps them in their
  // saved columns instead of losing them on the next reload.
  for (const container of items) {
    const minSlots = CONTAINER_MIN_SLOTS[container.element as string];
    if (minSlots === undefined) continue;
    const children = items.filter((candidate) => candidate.parentId === container.id);
    const maxCol = children.reduce((max, child) => Math.max(max, (typeof child.col === 'number' ? child.col : 0) + 1), 0);
    // FieldSet always keeps one trailing empty slot to drop the next item
    // into (its own addNewChild grows it further from there); Two/Three
    // ColumnRow never exceed their fixed column count.
    const slotCount = container.element === 'FieldSet' ? Math.max(minSlots, maxCol + 1) : Math.max(minSlots, maxCol);
    const slots: (string | null)[] = Array.from({ length: slotCount }, () => null);
    for (const child of children) {
      if (typeof child.col === 'number' && child.col >= 0 && child.col < slots.length) slots[child.col] = child.id;
    }
    container.childItems = slots;
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
  // react-form-builder2's own <Preview> only ever reads `data`/`onLoad` once,
  // at mount (`this.state = { data: props.data || [] }` in preview.jsx, with
  // no componentDidUpdate/getDerivedStateFromProps syncing it afterward) -
  // from then on it manages drops entirely through its own internal state,
  // updated only by drops ITS OWN drop targets accept and handle themselves
  // (`monitor.didDrop()` true). A drop this component's own fallback
  // `useDrop` below has to catch instead - any item type Preview's internal
  // targets don't recognize, which is every "Layout der aktiven Seite"
  // primitive (FieldSet/TwoColumnRow/ThreeColumnRow/Header/...), since only
  // "composition-block" cards are ever registered with the library's own
  // Registry - updates THIS component's `definition` prop and therefore
  // `data`, but Preview never finds out: nothing appeared in the canvas at
  // all when dropping e.g. "2 Spalten", confirmed live by the item being
  // completely absent from the rendered DOM even though the properties
  // panel showed it as selected (that selection is driven by `onSelect`
  // directly, bypassing Preview's rendering entirely). Bumping this counter
  // whenever the fallback handler below actually commits a change, and
  // folding it into <Builder>'s key, forces exactly the remount Preview
  // needs to pick the new item up via its `onLoad` - never needed for drops
  // Preview's own targets already handled reactively via their own state.
  //
  // The remount itself MUST be deferred a tick (setTimeout 0), not fired
  // synchronously inside this drop callback - confirmed live: unmounting
  // <Builder> (and the entire DndProvider-managed subtree under it,
  // including react-dnd's own HTML5Backend) while react-dnd is still
  // unwinding this exact drop's own internal bookkeeping hangs the page
  // outright (script execution stopped responding entirely, recovered only
  // by navigating away). Deferring lets react-dnd finish its own drop/drag
  // end handling first, then remounts on a clean stack.
  const [dropGeneration, setDropGeneration] = useState(0);
  const scheduleRemount = () => { setTimeout(() => setDropGeneration((generation) => generation + 1), 0); };
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
        scheduleRemount();
        return { destination: 'composition-canvas' };
      }
      const created = typeof item.onCreate === 'function' ? item.onCreate(item.data) : item.data;
      const element = created?.element as CompositionLayoutElement['element'] | undefined;
      if (!created?.id || !element || !['FieldSet', 'TwoColumnRow', 'ThreeColumnRow', 'Header', 'Label', 'Paragraph', 'LineBreak', 'HyperLink'].includes(element)) return undefined;
      onChange({ ...definition, pages: definition.pages.map((candidate) => candidate.id === page.id ? { ...candidate, layout: [...candidate.layout, { id: created.id, element, ...(created.label ? { label: created.label } : {}), ...(created.content || created.text ? { content: created.content || created.text } : {}) }] } : candidate) });
      onSelect(created.id);
      scheduleRemount();
      return { destination: 'composition-canvas' };
    },
    collect: (monitor) => ({ isOver: monitor.isOver({ shallow: true }) }),
  }), [definition, activePageId, onChange, onSelect]);
  return <div ref={drop} className="composition-builder-canvas" style={{ outline: isOver ? '2px solid #60a5fa' : undefined, outlineOffset: 6, minHeight: 180 }}><Builder key={`builder:${activePageId}:${dropGeneration}`} data={data} onLoad={async () => data} onPost={(post: unknown) => onChange(fromBuilder(Array.isArray(post) ? post as BuilderItem[] : ((post as any)?.task_data || data), definition, activePageId))} hideToolbar wrapDnd={false} renderEditForm={(props: any) => { onSelect(props.element?.id || null); return null; }} files={[]} /></div>;
}
