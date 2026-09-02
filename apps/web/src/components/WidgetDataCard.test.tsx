import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CompositionDataBlock } from 'core';
import { WidgetDataCard } from './WidgetDataCard';

function matrixBlock(overrides: Partial<CompositionDataBlock> = {}): CompositionDataBlock {
  return {
    id: 'block-matrix',
    type: 'data',
    title: 'Laborwerte',
    display: 'matrix',
    timeColumn: 'recordedAt',
    labelColumn: 'analyt',
    valueColumn: 'wert',
    ...overrides,
  };
}

function timelineBlock(overrides: Partial<CompositionDataBlock> = {}): CompositionDataBlock {
  return {
    id: 'block-timeline',
    type: 'data',
    title: 'Versorgungsverlauf',
    display: 'timeline',
    timeColumn: 'recordedAt',
    labelColumn: 'compositionName',
    valueColumn: 'composer',
    ...overrides,
  };
}

function listBlock(overrides: Partial<CompositionDataBlock> = {}): CompositionDataBlock {
  return {
    id: 'block-list',
    type: 'data',
    title: 'Ergebnisse',
    display: 'list',
    ...overrides,
  };
}

describe('WidgetDataCard - matrix display', () => {
  it('pivots rows into a parameter x day grid', () => {
    render(
      <WidgetDataCard
        block={matrixBlock()}
        state={{
          rows: [
            { analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' },
            { analyt: 'Hb', wert: 13.5, recordedAt: '2026-08-21T08:00:00Z' },
            { analyt: 'Leukozyten', wert: 7.2, recordedAt: '2026-08-20T08:00:00Z' },
          ],
        }}
      />,
    );
    // Row axis (labelColumn) and column axis (timeColumn, one column per day).
    expect(screen.getByText('Hb')).toBeInTheDocument();
    expect(screen.getByText('Leukozyten')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(3); // "Parameter" + 2 distinct days
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('13.5')).toBeInTheDocument();
    expect(screen.getByText('7.2')).toBeInTheDocument();
  });

  it('collapses same label+day rows to the later timestamp, not the first one', () => {
    render(
      <WidgetDataCard
        block={matrixBlock()}
        state={{
          rows: [
            { analyt: 'Hb', wert: 'früh', recordedAt: '2026-08-20T06:00:00Z' },
            { analyt: 'Hb', wert: 'spät', recordedAt: '2026-08-20T18:00:00Z' },
          ],
        }}
      />,
    );
    expect(screen.getByText('spät')).toBeInTheDocument();
    expect(screen.queryByText('früh')).not.toBeInTheDocument();
  });

  it('renders nothing when no row has a usable time value', () => {
    const { container } = render(
      <WidgetDataCard block={matrixBlock()} state={{ rows: [{ analyt: 'Hb', wert: 14 }] }} />,
    );
    expect(container.querySelector('table')).not.toBeInTheDocument();
  });

  it('calls onPick with the underlying row when a filled cell is clicked', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(
      <WidgetDataCard
        block={matrixBlock()}
        state={{ rows: [{ analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' }] }}
        onPick={onPick}
      />,
    );
    await user.click(screen.getByText('14'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ analyt: 'Hb', wert: 14 }));
  });

  it('suppresses the top-of-card reference-range line for a matrix widget', () => {
    render(
      <WidgetDataCard
        block={matrixBlock({ referenceRange: { min: 12, max: 16 } })}
        state={{ rows: [{ analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' }] }}
      />,
    );
    expect(screen.queryByText(/^Referenz:/)).not.toBeInTheDocument();
  });
});

describe('WidgetDataCard - timeline display', () => {
  it('renders one entry per row, sorted chronologically', () => {
    render(
      <WidgetDataCard
        block={timelineBlock()}
        state={{
          rows: [
            { compositionName: 'Entlassbrief', composer: 'Dr. Weber', recordedAt: '2026-08-22T10:00:00Z' },
            { compositionName: 'Aufnahme', composer: 'Dr. Meier', recordedAt: '2026-08-20T09:00:00Z' },
          ],
        }}
      />,
    );
    const labels = screen.getAllByText(/Aufnahme|Entlassbrief/).map((node) => node.textContent);
    expect(labels).toEqual(['Aufnahme', 'Entlassbrief']); // earlier entry first
  });

  it('renders nothing when there are no usable points', () => {
    const { container } = render(<WidgetDataCard block={timelineBlock()} state={{ rows: [] }} />);
    expect(container.querySelector('section')?.textContent).toContain('Keine Daten im gewählten Zeitraum');
  });

  it('calls onPick with the underlying row when an entry is clicked', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(
      <WidgetDataCard
        block={timelineBlock()}
        state={{ rows: [{ compositionName: 'Aufnahme', composer: 'Dr. Meier', recordedAt: '2026-08-20T09:00:00Z' }] }}
        onPick={onPick}
      />,
    );
    await user.click(screen.getByText('Aufnahme'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ compositionName: 'Aufnahme' }));
  });
});

describe('WidgetDataCard - list display', () => {
  it('renders a column for every key across all rows, not just the first row', () => {
    render(
      <WidgetDataCard
        block={listBlock()}
        state={{
          rows: [
            { analyt: 'Hb', wert: 14 },
            // This row has an extra key ("kommentar") the first row lacks -
            // before the fix, filtered[0]'s keys alone drove both the
            // header and every row's cells, so this column (and its data)
            // was silently dropped entirely, for every row.
            { analyt: 'Leukozyten', wert: 7.2, kommentar: 'leicht erhöht' },
          ],
        }}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'analyt' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'wert' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'kommentar' })).toBeInTheDocument();
    expect(screen.getByText('leicht erhöht')).toBeInTheDocument();
    // The first row has no "kommentar" value - its cell renders the same
    // missing-value placeholder used everywhere else in this component,
    // not a silently absent column.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
