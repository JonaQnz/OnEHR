import type { CSSProperties, ReactNode } from 'react';

/** Shared presentational primitives; domain runtimes supply their own blocks. */
export function ClinicalGrid({ columns = 1, children, style }: { columns?: 1 | 2 | 3; children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: '1rem', alignItems: 'start', ...style }}>{children}</div>;
}

export function ClinicalTabs({ tabs, activeId, onSelect }: { tabs: Array<{ id: string; label: string }>; activeId: string; onSelect: (id: string) => void }) {
  return <div role="tablist" style={{ display: 'flex', gap: '.5rem', borderBottom: '1px solid #e2e8f0', marginBottom: '1.25rem', overflowX: 'auto' }}>{tabs.map((tab) => <button key={tab.id} onClick={() => onSelect(tab.id)} style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: '.65rem .9rem', color: activeId === tab.id ? '#1d4ed8' : '#64748b', borderBottom: activeId === tab.id ? '2px solid #2563eb' : '2px solid transparent', fontWeight: 600 }}>{tab.label}</button>)}</div>;
}
