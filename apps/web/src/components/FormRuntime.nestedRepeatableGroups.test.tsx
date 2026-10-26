import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import FormRuntime from './FormRuntime';

// P0.2 UI half - nested repeats ("Repeat innerhalb Repeat"). The validation
// engine already understood a nested group's rows living inside each of its
// parent's row objects (see packages/core's nested-repeatable-groups.test.js
// and [[p02-repeatables-audit-and-first-fixes]]) - this file is the sibling
// that was deliberately left open: FormRuntime.tsx itself couldn't
// render/add/edit/remove a group nested inside another repeatable group's
// row, because rowsOf/updateGroupField/replaceGroupRows/GroupContext always
// read and wrote `values[groupId]` at the TOP level regardless of nesting.
//
// Same "Medikament" (outer) / "Einnahmezeitpunkt" (inner) shape as the core
// tests, so a bug caught in one layer's tests has a matching case here.
function nestedMedicationsDefinition({ outerMin = 0, outerMax = -1, innerMin = 0, innerMax = -1 } = {}) {
  return {
    id: 'meds-form', name: 'Medikation', version: '1.0.0',
    sourceTemplates: [{ alias: 'med', id: 'med.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    bindings: {},
    layout: {
      type: 'form',
      children: [{
        id: 'medications', type: 'container', label: 'Medikamente', repeatable: true, repeatMin: outerMin, repeatMax: outerMax,
        children: [
          { id: 'medication_name', type: 'input-text', label: 'Name' },
          {
            id: 'schedule', type: 'container', label: 'Einnahmezeitpunkt', repeatable: true, repeatMin: innerMin, repeatMax: innerMax,
            children: [{ id: 'time', type: 'input-text', label: 'Uhrzeit' }],
          },
        ],
      }],
    },
  } as const;
}

/** Scopes into one outer/inner row's own bordered card by its per-instance
 * heading text ("Medikamente 1", "Einnahmezeitpunkt 2", ...) - the same
 * `<strong>{label} {index + 1}</strong>` FormRuntime.tsx renders for every
 * repeatable-group row, nested or not. Two DOM levels up from the heading
 * text node reaches the row's own bordered container (the heading and its
 * row-action buttons share one flex div; that div's own parent is the row). */
function rowScope(label: string) {
  return within(screen.getByText(label).closest('div')!.parentElement!);
}

describe('FormRuntime nested repeatable groups', () => {
  it('renders every outer row\'s own nested rows with the right values, independently of its siblings', () => {
    render(
      <FormRuntime
        definition={nestedMedicationsDefinition() as any}
        initialValues={{
          medications: [
            { medication_name: 'Metformin', schedule: [{ time: '08:00' }, { time: '20:00' }] },
            { medication_name: 'Ibuprofen', schedule: [{ time: '12:00' }] },
          ],
        } as any}
        showSubmit={false}
        showHeader={false}
      />,
    );
    expect(screen.getByDisplayValue('Metformin')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ibuprofen')).toBeInTheDocument();
    expect(screen.getByDisplayValue('08:00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('20:00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('12:00')).toBeInTheDocument();
    // Metformin's own row has two nested instances, Ibuprofen's has one -
    // never a single shared top-level array both would otherwise collide on.
    expect(rowScope('Medikamente 1').getAllByText(/Einnahmezeitpunkt \d/)).toHaveLength(2);
    expect(rowScope('Medikamente 2').getAllByText(/Einnahmezeitpunkt \d/)).toHaveLength(1);
  });

  it('editing a field inside one specific (outer row, inner row) cell touches only that cell - no sibling inner row or sibling outer row changes', async () => {
    const onValuesChange = vi.fn();
    render(
      <FormRuntime
        definition={nestedMedicationsDefinition() as any}
        initialValues={{
          medications: [
            { medication_name: 'Metformin', schedule: [{ time: '08:00' }, { time: '20:00' }] },
            { medication_name: 'Ibuprofen', schedule: [{ time: '12:00' }] },
          ],
        } as any}
        showSubmit={false}
        showHeader={false}
        onValuesChange={onValuesChange}
      />,
    );
    fireEvent.change(screen.getByDisplayValue('08:00'), { target: { value: '09:00' } });
    await waitFor(() => {
      const values = onValuesChange.mock.calls.at(-1)![0];
      expect(values.medications[0].schedule).toEqual([{ time: '09:00' }, { time: '20:00' }]);
      expect(values.medications[1].schedule).toEqual([{ time: '12:00' }]);
    });
  });

  it('adding a nested row inside one outer row\'s own group only grows that outer row\'s own array', async () => {
    const onValuesChange = vi.fn();
    render(
      <FormRuntime
        definition={nestedMedicationsDefinition() as any}
        initialValues={{
          medications: [
            { medication_name: 'Metformin', schedule: [{ time: '08:00' }] },
            { medication_name: 'Ibuprofen', schedule: [{ time: '12:00' }] },
          ],
        } as any}
        showSubmit={false}
        showHeader={false}
        onValuesChange={onValuesChange}
      />,
    );
    fireEvent.click(rowScope('Medikamente 2').getByText('+ Eintrag hinzufügen'));
    await waitFor(() => {
      const values = onValuesChange.mock.calls.at(-1)![0];
      expect(values.medications[0].schedule).toEqual([{ time: '08:00' }]);
      expect(values.medications[1].schedule).toHaveLength(2);
    });
  });

  it('removing one specific inner row leaves that outer row\'s other inner rows, and the sibling outer row entirely, untouched', async () => {
    const onValuesChange = vi.fn();
    render(
      <FormRuntime
        definition={nestedMedicationsDefinition() as any}
        initialValues={{
          medications: [
            { medication_name: 'Metformin', schedule: [{ time: '08:00' }, { time: '20:00' }] },
            { medication_name: 'Ibuprofen', schedule: [{ time: '12:00' }] },
          ],
        } as any}
        showSubmit={false}
        showHeader={false}
        onValuesChange={onValuesChange}
      />,
    );
    const firstScheduleRowOfFirstMedication = within(
      rowScope('Medikamente 1').getByText('Einnahmezeitpunkt 1').closest('div')!.parentElement!,
    );
    fireEvent.click(firstScheduleRowOfFirstMedication.getByText('Entfernen'));
    await waitFor(() => {
      const values = onValuesChange.mock.calls.at(-1)![0];
      expect(values.medications[0].schedule).toEqual([{ time: '20:00' }]);
      expect(values.medications[1].schedule).toEqual([{ time: '12:00' }]);
    });
  });

  it('duplicating an outer row copies its nested schedule array, but editing the copy\'s inner row never mutates the source outer row\'s own inner row', async () => {
    const onValuesChange = vi.fn();
    render(
      <FormRuntime
        definition={nestedMedicationsDefinition() as any}
        initialValues={{
          medications: [{ medication_name: 'Metformin', schedule: [{ time: '08:00' }] }],
        } as any}
        showSubmit={false}
        showHeader={false}
        onValuesChange={onValuesChange}
      />,
    );
    // The outer row's own "Duplizieren" button, not its nested schedule
    // row's identically-labeled one - rowActions for the outer row itself
    // renders before its children (the nested group), so it's first in DOM
    // order within this row's scope.
    fireEvent.click(rowScope('Medikamente 1').getAllByText('Duplizieren')[0]);
    await waitFor(() => expect(screen.getAllByDisplayValue('08:00')).toHaveLength(2));
    const [, duplicatedTimeInput] = screen.getAllByDisplayValue('08:00');
    fireEvent.change(duplicatedTimeInput, { target: { value: '14:00' } });
    await waitFor(() => {
      const values = onValuesChange.mock.calls.at(-1)![0];
      expect(values.medications[0].schedule).toEqual([{ time: '08:00' }]);
      expect(values.medications[1].schedule).toEqual([{ time: '14:00' }]);
    });
  });
});
