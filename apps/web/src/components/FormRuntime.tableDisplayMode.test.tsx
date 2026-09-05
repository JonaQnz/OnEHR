import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FormRuntime from './FormRuntime';

// P0.2 audit (2026-09-05): "Tabelle vs. Cards" repeatable-group display
// mode. Opt-in via FormElementLayout.displayMode: 'table' - absent/'cards'
// is the pre-existing, unchanged stacked-card layout (see
// FormRuntime.repeatableGroupControls.test.tsx for that). Column headers
// come from flattening through the real container>row>column>field nesting
// every archetype-driven layout actually uses (collectTableColumns) - the
// definition below deliberately nests fields that way, not directly under
// the container, so this exercises the real shape, not a simplified one.
function medicationsTableDefinition(repeatMin = 0, repeatMax = -1) {
  return {
    id: 'meds-form', name: 'Medikation', version: '1.0.0',
    sourceTemplates: [{ alias: 'med', id: 'med.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    bindings: {},
    layout: {
      type: 'form',
      children: [{
        id: 'medications', type: 'container', label: 'Medikamente', repeatable: true, repeatMin, repeatMax, displayMode: 'table',
        children: [
          {
            type: 'row', children: [{
              type: 'column', children: [{
                id: 'medication_name', type: 'input-text', label: 'Name', required: true,
                binding: { templateAlias: 'med', path: '/content/items[at0001]', rmType: 'DV_TEXT' },
              }],
            }],
          },
          {
            type: 'row', children: [{
              type: 'column', children: [{
                id: 'dose', type: 'input-number', label: 'Dosis',
                binding: { templateAlias: 'med', path: '/content/items[at0002]', rmType: 'DV_COUNT' },
              }],
            }],
          },
        ],
      }],
    },
  } as const;
}

describe('FormRuntime repeatable group table display mode', () => {
  it('renders one column header per leaf field, flattened through row/column wrappers', () => {
    render(
      <FormRuntime
        definition={medicationsTableDefinition() as any}
        initialValues={{ medications: [{ medication_name: 'Metformin', dose: 500 }] } as any}
        showSubmit={false}
        showHeader={false}
      />,
    );
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Dosis')).toBeInTheDocument();
    // Actual table structure, not the card layout's per-instance heading.
    expect(document.querySelector('table')).toBeInTheDocument();
    expect(screen.queryByText('Medikamente 1')).not.toBeInTheDocument();
  });

  it('renders one row per instance with the right values in each cell', () => {
    render(
      <FormRuntime
        definition={medicationsTableDefinition() as any}
        initialValues={{ medications: [{ medication_name: 'Metformin', dose: 500 }, { medication_name: 'Ibuprofen', dose: 400 }] } as any}
        showSubmit={false}
        showHeader={false}
      />,
    );
    expect(screen.getByDisplayValue('Metformin')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ibuprofen')).toBeInTheDocument();
    expect(screen.getByDisplayValue('500')).toBeInTheDocument();
    expect(screen.getByDisplayValue('400')).toBeInTheDocument();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('editing a cell reports the change against the right row, same values shape as card mode', async () => {
    const onValuesChange = vi.fn();
    render(
      <FormRuntime
        definition={medicationsTableDefinition() as any}
        initialValues={{ medications: [{ medication_name: 'Metformin', dose: 500 }] } as any}
        showSubmit={false}
        showHeader={false}
        onValuesChange={onValuesChange}
      />,
    );
    fireEvent.change(screen.getByDisplayValue('500'), { target: { value: '850' } });
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({
      medications: [{ medication_name: 'Metformin', dose: 850 }],
    })));
  });

  it('the row-action buttons (↑/↓/Duplizieren/Entfernen) are still present and functional in table mode', async () => {
    const onValuesChange = vi.fn();
    render(
      <FormRuntime
        definition={medicationsTableDefinition() as any}
        initialValues={{ medications: [{ medication_name: 'Metformin', dose: 500 }] } as any}
        showSubmit={false}
        showHeader={false}
        onValuesChange={onValuesChange}
      />,
    );
    fireEvent.click(screen.getByText('Duplizieren'));
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({
      medications: [{ medication_name: 'Metformin', dose: 500 }, { medication_name: 'Metformin', dose: 500 }],
    })));
  });

  it('a group with no displayMode set (the pre-existing default) still renders as cards, not a table', () => {
    const definition = medicationsTableDefinition();
    const cardsDefinition = { ...definition, layout: { ...definition.layout, children: [{ ...definition.layout.children[0], displayMode: undefined }] } };
    render(
      <FormRuntime
        definition={cardsDefinition as any}
        initialValues={{ medications: [{ medication_name: 'Metformin', dose: 500 }] } as any}
        showSubmit={false}
        showHeader={false}
      />,
    );
    expect(document.querySelector('table')).not.toBeInTheDocument();
    expect(screen.getByText('Medikamente 1')).toBeInTheDocument();
  });
});
