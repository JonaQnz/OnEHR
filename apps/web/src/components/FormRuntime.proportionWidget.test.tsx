import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FormRuntime from './FormRuntime';

// DV_PROPORTION widget, added 2026-09-02 alongside full DV_PROPORTION
// backend support (openEHR RM data_types.html PROPORTION_KIND). Widget UX
// decision confirmed with the user: 'percent'/'unitary' (denominator
// implied by the archetype - 100 / 1) show a single number field;
// 'ratio'/'fraction'/'integer_fraction' (numerator AND denominator vary)
// show both side by side.

function proportionDefinition(proportionType?: string) {
  return {
    id: 'vitals-form', name: 'Vitals', version: '1.0.0',
    sourceTemplates: [{ alias: 'vitals', id: 'vitals.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    bindings: {},
    layout: {
      type: 'form',
      children: [{
        id: 'fio2', type: 'input-proportion', label: 'FiO2',
        binding: { templateAlias: 'vitals', path: '/content/data/items[at0002]', rmType: 'DV_PROPORTION' },
        ...(proportionType ? { proportionType } : {}),
      }],
    },
  } as const;
}

describe('FormRuntime input-proportion widget - implied-denominator kinds (percent/unitary)', () => {
  it('renders a single number field, no denominator input at all', () => {
    render(<FormRuntime definition={proportionDefinition('percent') as any} showSubmit={false} showHeader={false} />);
    const numberInputs = document.querySelectorAll('input[type="number"]');
    expect(numberInputs).toHaveLength(1);
  });

  it('percent shows a trailing "%" hint next to the field', () => {
    render(<FormRuntime definition={proportionDefinition('percent') as any} showSubmit={false} showHeader={false} />);
    expect(screen.getByText('%')).toBeInTheDocument();
  });

  it('unitary shows no "%" hint (only percent gets one)', () => {
    render(<FormRuntime definition={proportionDefinition('unitary') as any} showSubmit={false} showHeader={false} />);
    expect(screen.queryByText('%')).not.toBeInTheDocument();
  });

  it('typing a value reports {numerator} only - no denominator key at all, filled in server-side', async () => {
    const onValuesChange = vi.fn();
    render(<FormRuntime definition={proportionDefinition('percent') as any} showSubmit={false} showHeader={false} onValuesChange={onValuesChange} />);
    const input = document.querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '45.2' } });
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({ fio2: { numerator: 45.2 } })));
  });

  it('an existing {numerator, denominator} initial value shows only the numerator in the field', () => {
    render(<FormRuntime definition={proportionDefinition('unitary') as any} initialValues={{ fio2: { numerator: 0.35, denominator: 1 } } as any} showSubmit={false} showHeader={false} />);
    expect(document.querySelector('input[type="number"]')).toHaveValue(0.35);
  });
});

describe('FormRuntime input-proportion widget - variable-denominator kinds (ratio/fraction/none)', () => {
  it('renders two number fields (Zähler / Nenner) for type "ratio"', () => {
    render(<FormRuntime definition={proportionDefinition('ratio') as any} showSubmit={false} showHeader={false} />);
    expect(screen.getByPlaceholderText('Zähler')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Nenner')).toBeInTheDocument();
  });

  it('a field with no proportionType at all also gets two fields (unconstrained defaults to the "ratio" shape)', () => {
    render(<FormRuntime definition={proportionDefinition(undefined) as any} showSubmit={false} showHeader={false} />);
    expect(screen.getByPlaceholderText('Zähler')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Nenner')).toBeInTheDocument();
  });

  it('typing both fields reports a full {numerator, denominator}', async () => {
    const onValuesChange = vi.fn();
    render(<FormRuntime definition={proportionDefinition('ratio') as any} showSubmit={false} showHeader={false} onValuesChange={onValuesChange} />);
    fireEvent.change(screen.getByPlaceholderText('Zähler'), { target: { value: '1' } });
    fireEvent.change(screen.getByPlaceholderText('Nenner'), { target: { value: '128' } });
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({ fio2: { numerator: 1, denominator: 128 } })));
  });

  it('an existing {numerator, denominator} initial value pre-fills both fields', () => {
    render(<FormRuntime definition={proportionDefinition('ratio') as any} initialValues={{ fio2: { numerator: 1, denominator: 128 } } as any} showSubmit={false} showHeader={false} />);
    expect(screen.getByPlaceholderText('Zähler')).toHaveValue(1);
    expect(screen.getByPlaceholderText('Nenner')).toHaveValue(128);
  });
});
