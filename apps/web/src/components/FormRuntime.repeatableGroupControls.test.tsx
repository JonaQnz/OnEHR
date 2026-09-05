import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FormRuntime from './FormRuntime';

// P0.2 audit (2026-09-05): "Add/Delete/Duplicate" and "Drag/Reorder" for
// repeatable groups (see docs/architecture/migration-plan.md's P0.2). Add
// and Delete already existed; this covers the two genuinely new controls
// (Duplizieren, ↑/↓ reorder) plus min/max enforcement across all of them.
// The parallel stable-row-key mechanism these controls also rely on (see
// FormRuntime.tsx's rowKeysRef doc comment - fixes a real React key/DOM-
// identity bug on remove/reorder) isn't independently asserted here: it's
// an internal rendering-identity concern, not something distinguishable
// from correct VALUES via Testing Library's own DOM-state queries.
function medicationsDefinition(repeatMin = 0, repeatMax = -1) {
  return {
    id: 'meds-form', name: 'Medikation', version: '1.0.0',
    sourceTemplates: [{ alias: 'med', id: 'med.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    bindings: {},
    layout: {
      type: 'form',
      children: [{
        id: 'medications', type: 'container', label: 'Medikamente', repeatable: true, repeatMin, repeatMax,
        children: [{
          id: 'medication_name', type: 'input-text', label: 'Name',
          binding: { templateAlias: 'med', path: '/content/items[at0001]', rmType: 'DV_TEXT' },
        }],
      }],
    },
  } as const;
}

describe('FormRuntime repeatable group controls', () => {
  it('Duplizieren copies the source row\'s values into a brand-new row right after it', async () => {
    const onValuesChange = vi.fn();
    render(
      <FormRuntime
        definition={medicationsDefinition() as any}
        initialValues={{ medications: [{ medication_name: 'Metformin' }] } as any}
        showSubmit={false}
        showHeader={false}
        onValuesChange={onValuesChange}
      />,
    );
    fireEvent.click(screen.getByText('Duplizieren'));
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({
      medications: [{ medication_name: 'Metformin' }, { medication_name: 'Metformin' }],
    })));
  });

  it('Duplizieren is disabled once the group is at its archetype-configured maximum', () => {
    render(
      <FormRuntime
        definition={medicationsDefinition(0, 1) as any}
        initialValues={{ medications: [{ medication_name: 'Metformin' }] } as any}
        showSubmit={false}
        showHeader={false}
      />,
    );
    expect(screen.getByText('Duplizieren')).toBeDisabled();
  });

  it('reordering with ↓ moves a row\'s values down, not just its position label', async () => {
    const onValuesChange = vi.fn();
    render(
      <FormRuntime
        definition={medicationsDefinition() as any}
        initialValues={{ medications: [{ medication_name: 'Metformin' }, { medication_name: 'Ibuprofen' }] } as any}
        showSubmit={false}
        showHeader={false}
        onValuesChange={onValuesChange}
      />,
    );
    const [moveDownFirstRow] = screen.getAllByLabelText('Nach unten verschieben');
    fireEvent.click(moveDownFirstRow);
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({
      medications: [{ medication_name: 'Ibuprofen' }, { medication_name: 'Metformin' }],
    })));
  });

  it('the first row\'s ↑ and the last row\'s ↓ are disabled - nothing to move past either end', () => {
    render(
      <FormRuntime
        definition={medicationsDefinition() as any}
        initialValues={{ medications: [{ medication_name: 'Metformin' }, { medication_name: 'Ibuprofen' }] } as any}
        showSubmit={false}
        showHeader={false}
      />,
    );
    const [upFirst, upSecond] = screen.getAllByLabelText('Nach oben verschieben');
    const [downFirst, downSecond] = screen.getAllByLabelText('Nach unten verschieben');
    expect(upFirst).toBeDisabled();
    expect(upSecond).not.toBeDisabled();
    expect(downFirst).not.toBeDisabled();
    expect(downSecond).toBeDisabled();
  });

  it('removing the middle row of three leaves the other two rows\' own values intact and correctly ordered', async () => {
    const onValuesChange = vi.fn();
    render(
      <FormRuntime
        definition={medicationsDefinition() as any}
        initialValues={{ medications: [{ medication_name: 'Metformin' }, { medication_name: 'Ibuprofen' }, { medication_name: 'Enoxaparin' }] } as any}
        showSubmit={false}
        showHeader={false}
        onValuesChange={onValuesChange}
      />,
    );
    const removeButtons = screen.getAllByText('Entfernen');
    fireEvent.click(removeButtons[1]);
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({
      medications: [{ medication_name: 'Metformin' }, { medication_name: 'Enoxaparin' }],
    })));
  });

  it('Entfernen is disabled once the group is down to its archetype-configured minimum', () => {
    render(
      <FormRuntime
        definition={medicationsDefinition(1) as any}
        initialValues={{ medications: [{ medication_name: 'Metformin' }] } as any}
        showSubmit={false}
        showHeader={false}
      />,
    );
    expect(screen.getByText('Entfernen')).toBeDisabled();
  });
});
