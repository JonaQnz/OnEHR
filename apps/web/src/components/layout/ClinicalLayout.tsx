import type { CSSProperties, ReactNode } from 'react';

/** Shared presentational primitives; domain runtimes supply their own blocks. */
export function ClinicalGrid({ columns = 1, children, style }: { columns?: 1 | 2 | 3; children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: '1rem', alignItems: 'start', ...style }}>{children}</div>;
}

export function ClinicalTabs({ tabs, activeId, onSelect }: { tabs: Array<{ id: string; label: string }>; activeId: string; onSelect: (id: string) => void }) {
  return <div role="tablist" style={{ display: 'flex', gap: '.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1.25rem', overflowX: 'auto' }}>{tabs.map((tab) => <button key={tab.id} role="tab" aria-selected={activeId === tab.id} onClick={() => onSelect(tab.id)} style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: '.65rem .9rem', color: activeId === tab.id ? 'var(--primary)' : 'var(--text-muted)', borderBottom: activeId === tab.id ? '2px solid var(--primary)' : '2px solid transparent', fontWeight: 600, whiteSpace: 'nowrap' }}>{tab.label}</button>)}</div>;
}

/**
 * Every (non-hidden) page rendered as its own titled, collapsible section,
 * stacked vertically instead of switched between via ClinicalTabs - the
 * alternative Composition-runtime view mode. Native <details>/<summary>,
 * matching the two other ad-hoc collapsible uses already in this app
 * (WidgetDataCard's data-detail panel, the script editor's connector
 * reference) rather than introducing a new accordion component.
 */
export function ClinicalStack({ sections }: { sections: Array<{ id: string; title: string; description?: string; content: ReactNode }> }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>{sections.map((section) => (
    <details key={section.id} open style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)' }}>
      <summary style={{ cursor: 'pointer', padding: '1rem 1.25rem', fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-main)', listStyle: 'none' }}>
        {section.title}
        {section.description && <span style={{ display: 'block', fontWeight: 400, fontSize: '.85rem', color: 'var(--text-muted)', marginTop: '.25rem' }}>{section.description}</span>}
      </summary>
      <div style={{ padding: '0 1.25rem 1.25rem' }}>{section.content}</div>
    </details>
  ))}</div>;
}
