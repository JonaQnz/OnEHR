import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrefillConflictDialog, type PrefillConflictItem } from './PrefillConflictDialog';

function conflict(overrides: Partial<PrefillConflictItem> = {}): PrefillConflictItem {
  return {
    requestId: 'req-1',
    fieldId: 'diagnosis_name',
    fieldLabel: 'Diagnosename',
    currentValue: 'Manuell eingetragen',
    prefillValue: 'Aus AQL geladen',
    ...overrides,
  };
}

describe('PrefillConflictDialog', () => {
  it('renders nothing when there are no conflicts', () => {
    const { container } = render(<PrefillConflictDialog conflicts={[]} onResolve={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the field label and both current/prefill values', () => {
    render(<PrefillConflictDialog conflicts={[conflict()]} onResolve={vi.fn()} />);
    expect(screen.getByText('Diagnosename')).toBeInTheDocument();
    expect(screen.getByText('Manuell eingetragen')).toBeInTheDocument();
    expect(screen.getByText('Aus AQL geladen')).toBeInTheDocument();
  });

  it('"Manuelle Werte behalten" resolves every conflict with apply: false', async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(<PrefillConflictDialog conflicts={[conflict(), conflict({ requestId: 'req-2', fieldId: 'other' })]} onResolve={onResolve} />);
    await user.click(screen.getByRole('button', { name: 'Manuelle Werte behalten' }));
    expect(onResolve).toHaveBeenCalledWith([
      { requestId: 'req-1', apply: false },
      { requestId: 'req-2', apply: false },
    ]);
  });

  it('"Werte aus AQL übernehmen" resolves every conflict with apply: true', async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(<PrefillConflictDialog conflicts={[conflict(), conflict({ requestId: 'req-2', fieldId: 'other' })]} onResolve={onResolve} />);
    await user.click(screen.getByRole('button', { name: 'Werte aus AQL übernehmen' }));
    expect(onResolve).toHaveBeenCalledWith([
      { requestId: 'req-1', apply: true },
      { requestId: 'req-2', apply: true },
    ]);
  });

  it('every conflict starts pre-selected for overwrite, so "Auswahl übernehmen" with no changes behaves like overwrite-all', async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(<PrefillConflictDialog conflicts={[conflict()]} onResolve={onResolve} />);
    await user.click(screen.getByRole('button', { name: 'Auswahl übernehmen' }));
    expect(onResolve).toHaveBeenCalledWith([{ requestId: 'req-1', apply: true }]);
  });

  it('unchecking a field before "Auswahl übernehmen" resolves only that one with apply: false', async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(<PrefillConflictDialog conflicts={[conflict(), conflict({ requestId: 'req-2', fieldId: 'other', fieldLabel: 'Anderes Feld' })]} onResolve={onResolve} />);
    await user.click(screen.getAllByRole('checkbox')[0]);
    await user.click(screen.getByRole('button', { name: 'Auswahl übernehmen' }));
    expect(onResolve).toHaveBeenCalledWith([
      { requestId: 'req-1', apply: false },
      { requestId: 'req-2', apply: true },
    ]);
  });

  it('falls back to the field id when no fieldLabel is given', () => {
    render(<PrefillConflictDialog conflicts={[conflict({ fieldLabel: undefined })]} onResolve={vi.fn()} />);
    expect(screen.getByText('diagnosis_name')).toBeInTheDocument();
  });

  it('renders "(leer)" for a nullish current value, not the literal empty string', () => {
    render(<PrefillConflictDialog conflicts={[conflict({ currentValue: null })]} onResolve={vi.fn()} />);
    expect(screen.getByText('(leer)')).toBeInTheDocument();
  });
});
