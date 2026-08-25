import { useMemo, useState } from 'react';
import { AlertTriangle, BarChart3 } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CompositionDataBlock } from 'core';

/**
 * Renders one clinical data widget's already-fetched rows as metric/table/
 * trend/text - whatever `block.display` says. Single source of truth for
 * this: it used to be defined only inside CompositionRuntime.tsx, which
 * meant the only way to see what a widget actually looks like was to build
 * a whole Composition first. Widgets admin's own preview reuses this same
 * component so both places render a widget identically, and a future third
 * consumer doesn't have to duplicate chart code to get there.
 */
export type WidgetDataState = { rows?: Record<string, unknown>[]; error?: string; loading?: boolean };

const first = (row: Record<string, unknown>, column?: string): unknown => column && row[column] !== undefined ? row[column] : Object.values(row).find((value) => value !== undefined && value !== null) ?? '—';
const number = (row: Record<string, unknown>, column?: string): number | undefined => { const value = Number(first(row, column)); return Number.isFinite(value) ? value : undefined; };
const date = (row: Record<string, unknown>, column?: string): number | undefined => { const value = first(row, column); const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN; return Number.isFinite(parsed) ? parsed : undefined; };

function severity(value: number | undefined, block: CompositionDataBlock): 'normal' | 'warning' | 'critical' { if (value === undefined) return 'normal'; const range = block.referenceRange; if (!range) return 'normal'; if ((range.criticalLow !== undefined && value < range.criticalLow) || (range.criticalHigh !== undefined && value > range.criticalHigh)) return 'critical'; if ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max)) return 'warning'; return 'normal'; }

function Metric({ value, level }: { value: number | undefined; level: 'normal' | 'warning' | 'critical' }) { const color = level === 'critical' ? '#b91c1c' : level === 'warning' ? '#a16207' : '#0f172a'; return <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', fontSize: '2rem', fontWeight: 700, color }}>{level !== 'normal' && <AlertTriangle size={22} />}{value ?? '—'}</div>; }

function Trend({ points, block, onPick }: { points: Array<{ row: Record<string, unknown>; value: number; time: number }>; block: CompositionDataBlock; onPick: (row: Record<string, unknown>) => void }) {
  const chartData = points.map((point) => ({
    value: point.value,
    recordedAt: new Date(point.time).toLocaleDateString('de-DE'),
    recordedAtFull: new Date(point.time).toLocaleString('de-DE'),
    row: point.row,
  }));
  const Chart = block.chartType === 'area' ? AreaChart : block.chartType === 'bar' ? BarChart : LineChart;
  const series = block.chartType === 'area'
    ? <Area type="monotone" dataKey="value" stroke="#2563eb" fill="#bfdbfe" strokeWidth={2} activeDot={{ r: 5 }} />
    : block.chartType === 'bar'
      ? <Bar dataKey="value" fill="#2563eb" radius={[4, 4, 0, 0]} />
      : <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={3} dot={{ r: 3 }} activeDot={{ r: 5 }} />;
  return <div style={{ height: 260, minWidth: 0 }}><ResponsiveContainer width="100%" height="100%"><Chart data={chartData} margin={{ top: 12, right: 18, bottom: 0, left: 0 }} onClick={(event: any) => { const row = event?.activePayload?.[0]?.payload?.row; if (row) onPick(row); }}><CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" /><XAxis dataKey="recordedAt" tick={{ fontSize: 12, fill: '#64748b' }} /><YAxis tick={{ fontSize: 12, fill: '#64748b' }} width={42} />{block.referenceRange?.min !== undefined && block.referenceRange?.max !== undefined && <ReferenceArea y1={block.referenceRange.min} y2={block.referenceRange.max} fill="#dcfce7" fillOpacity={0.35} />}<Tooltip labelFormatter={(_label, payload) => payload?.[0]?.payload?.recordedAtFull || ''} formatter={(value: unknown) => [String(value ?? '—'), block.title]} />{series}</Chart></ResponsiveContainer></div>;
}

export function WidgetDataCard({ block, state }: { block: CompositionDataBlock; state?: WidgetDataState }) {
  const [period, setPeriod] = useState<'all' | '7d' | '30d' | '90d'>('all'); const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const rows = state?.rows || []; const filtered = useMemo(() => { if (period === 'all' || !block.timeColumn) return rows; const start = Date.now() - ({ '7d': 7, '30d': 30, '90d': 90 }[period] * 86400000); return rows.filter((row) => (date(row, block.timeColumn) || 0) >= start); }, [rows, period, block.timeColumn]);
  const points = useMemo(() => filtered.map((row) => ({ row, value: number(row, block.valueColumn), time: date(row, block.timeColumn) })).filter((item): item is { row: Record<string, unknown>; value: number; time: number } => item.value !== undefined && item.time !== undefined).sort((a, b) => a.time - b.time), [filtered, block.valueColumn, block.timeColumn]);
  return <section className="card"><div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginBottom: '.8rem' }}><BarChart3 size={18} color="#2563eb" /><strong>{block.title}</strong><label style={{ marginLeft: 'auto', fontSize: '.78rem', color: '#64748b' }}>Zeitraum <select value={period} onChange={(event) => setPeriod(event.target.value as typeof period)} style={{ marginLeft: '.35rem' }}><option value="all">Alle</option><option value="7d">7 Tage</option><option value="30d">30 Tage</option><option value="90d">90 Tage</option></select></label></div>{state?.loading && <span style={{ color: '#64748b' }}>Daten werden abgefragt…</span>}{state?.error && <span style={{ color: '#b91c1c' }}>{state.error}</span>}{!state?.loading && !state?.error && filtered.length === 0 && <span style={{ color: '#64748b' }}>Keine Daten im gewählten Zeitraum.</span>}{block.referenceRange && <div style={{ fontSize: '.78rem', color: '#64748b', marginBottom: '.7rem' }}>Referenz: {block.referenceRange.min ?? '−∞'} bis {block.referenceRange.max ?? '+∞'}{block.referenceRange.criticalLow !== undefined || block.referenceRange.criticalHigh !== undefined ? ` · kritisch außerhalb ${block.referenceRange.criticalLow ?? '−∞'}–${block.referenceRange.criticalHigh ?? '+∞'}` : ''}</div>}{block.display === 'metric' && filtered[0] && <Metric value={number(filtered[0], block.valueColumn)} level={severity(number(filtered[0], block.valueColumn), block)} />}{block.display === 'text' && filtered.map((row, index) => <p key={index} style={{ margin: '.4rem 0', color: severity(number(row, block.valueColumn), block) === 'critical' ? '#b91c1c' : undefined }}>{String(first(row, block.labelColumn))}: <strong>{String(first(row, block.valueColumn))}</strong></p>)}{block.display === 'trend' && points.length > 0 && <Trend points={points} block={block} onPick={(row) => setSelected(row)} />}{block.display === 'list' && filtered.length > 0 && <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.85rem' }}><thead><tr>{Object.keys(filtered[0]).map((key) => <th key={key} style={{ textAlign: 'left', color: '#64748b', padding: '.45rem', borderBottom: '1px solid #e2e8f0' }}>{key}</th>)}</tr></thead><tbody>{filtered.map((row, index) => <tr key={index} onClick={() => setSelected(row)} style={{ cursor: 'pointer', background: severity(number(row, block.valueColumn), block) === 'critical' ? '#fef2f2' : severity(number(row, block.valueColumn), block) === 'warning' ? '#fffbeb' : undefined }}>{Object.keys(filtered[0]).map((key) => <td key={key} style={{ padding: '.45rem', borderBottom: '1px solid #f1f5f9' }}>{String(row[key] ?? '—')}</td>)}</tr>)}</tbody></table></div>}{selected && <details open style={{ marginTop: '.9rem', borderTop: '1px solid #e2e8f0', paddingTop: '.7rem' }}><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Composition-Version / Datendetails</summary><pre style={{ overflow: 'auto', background: '#f8fafc', padding: '.75rem', fontSize: '.75rem' }}>{JSON.stringify(selected, null, 2)}</pre></details>}</section>;
}
