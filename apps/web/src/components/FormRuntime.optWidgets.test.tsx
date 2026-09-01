import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FormRuntime from './FormRuntime';

// Covers the two new OPT constraint engine widgets (section 19 of
// docs/features/opt-constraint-engine-analysis.md's architecture):
// - CodedWithOther: "DV_CODED_TEXT + DV_TEXT -> Coded Choice + 'Other / free text'"
// - Autocomplete: "DV_CODED_TEXT + große/externe Terminologie -> Search / Autocomplete"
// Both are real vg_Diagnosis.v1.1.1 shapes (severity/at0005 for the first;
// a synthetic large option set for the second, since no real field in that
// template needs it).

const SEVERITY_OPTIONS = [
  { value: 'at0047', text: 'Leicht' },
  { value: 'at0048', text: 'Mäßig' },
  { value: 'at0049', text: 'Schwer' },
];

function severityDefinition(initialAllowFreeText = true) {
  return {
    id: 'diag-form', name: 'Diagnose', version: '1.0.0',
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    bindings: {},
    layout: {
      type: 'form',
      children: [{
        id: 'severity', type: 'input-select', label: 'Schweregrad', uiElement: 'CodedWithOther',
        binding: { templateAlias: 'diag', path: '/content/data/items[at0005]', rmType: 'DV_CODED_TEXT' },
        options: SEVERITY_OPTIONS,
        allowFreeText: initialAllowFreeText,
      }],
    },
  } as const;
}

describe('FormRuntime CodedWithOther widget', () => {
  it('renders one radio per option plus a trailing "Anderer Wert" radio, none selected initially', () => {
    render(<FormRuntime definition={severityDefinition() as any} showSubmit={false} showHeader={false} />);
    expect(screen.getByText('Leicht')).toBeInTheDocument();
    expect(screen.getByText('Mäßig')).toBeInTheDocument();
    expect(screen.getByText('Schwer')).toBeInTheDocument();
    expect(screen.getByText('Anderer Wert …')).toBeInTheDocument();
    const radios = document.querySelectorAll('input[type="radio"]');
    expect(radios).toHaveLength(4);
    radios.forEach((radio) => expect(radio).not.toBeChecked());
    // The free-text input only appears once "Anderer Wert" is selected.
    expect(screen.queryByPlaceholderText('Freitext eingeben …')).not.toBeInTheDocument();
  });

  it('selecting a coded option reports the plain code, no free-text input shown', async () => {
    const onValuesChange = vi.fn();
    render(<FormRuntime definition={severityDefinition() as any} showSubmit={false} showHeader={false} onValuesChange={onValuesChange} />);
    fireEvent.click(screen.getByLabelText('Mäßig'));
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({ severity: 'at0048' })));
    expect(screen.queryByPlaceholderText('Freitext eingeben …')).not.toBeInTheDocument();
  });

  it('selecting "Anderer Wert" reveals a free-text input; typing reports the typed text as the value', async () => {
    const onValuesChange = vi.fn();
    render(<FormRuntime definition={severityDefinition() as any} showSubmit={false} showHeader={false} onValuesChange={onValuesChange} />);
    fireEvent.click(screen.getByLabelText('Anderer Wert …'));
    const freeTextInput = await screen.findByPlaceholderText('Freitext eingeben …');
    fireEvent.change(freeTextInput, { target: { value: 'Leicht bis mäßig, wechselnd' } });
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({ severity: 'Leicht bis mäßig, wechselnd' })));
  });

  it('switching from free text back to a coded option hides the free-text input again', async () => {
    const onValuesChange = vi.fn();
    render(<FormRuntime definition={severityDefinition() as any} showSubmit={false} showHeader={false} onValuesChange={onValuesChange} />);
    fireEvent.click(screen.getByLabelText('Anderer Wert …'));
    await screen.findByPlaceholderText('Freitext eingeben …');
    fireEvent.click(screen.getByLabelText('Schwer'));
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({ severity: 'at0049' })));
    expect(screen.queryByPlaceholderText('Freitext eingeben …')).not.toBeInTheDocument();
  });

  it('an existing free-text initial value (not matching any option) starts in "Anderer Wert" mode with the text pre-filled', () => {
    const definition = severityDefinition();
    render(<FormRuntime definition={definition as any} initialValues={{ severity: 'Schon vorhandener Freitext' } as any} showSubmit={false} showHeader={false} />);
    expect(screen.getByLabelText('Anderer Wert …')).toBeChecked();
    expect(screen.getByPlaceholderText('Freitext eingeben …')).toHaveValue('Schon vorhandener Freitext');
  });

  it('an existing coded initial value shows that option selected, not "Anderer Wert"', () => {
    const definition = severityDefinition();
    render(<FormRuntime definition={definition as any} initialValues={{ severity: 'at0047' } as any} showSubmit={false} showHeader={false} />);
    expect(screen.getByLabelText('Leicht')).toBeChecked();
    expect(screen.getByLabelText('Anderer Wert …')).not.toBeChecked();
    expect(screen.queryByPlaceholderText('Freitext eingeben …')).not.toBeInTheDocument();
  });

  it('more than 6 options renders a <select> with a trailing "Anderer Wert" entry instead of a radio group', () => {
    const manyOptionsDefinition = {
      ...severityDefinition(),
      layout: {
        type: 'form',
        children: [{
          id: 'category', type: 'input-select', label: 'Kategorie', uiElement: 'CodedWithOther',
          binding: { templateAlias: 'diag', path: '/content/data/items[at0009]', rmType: 'DV_CODED_TEXT' },
          options: Array.from({ length: 8 }, (_, i) => ({ value: `at00${i}`, text: `Option ${i}` })),
          allowFreeText: true,
        }],
      },
    };
    render(<FormRuntime definition={manyOptionsDefinition as any} showSubmit={false} showHeader={false} />);
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    const select = document.querySelector('select') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(Array.from(select.options).some((option) => option.textContent === 'Anderer Wert …')).toBe(true);
  });
});

function autocompleteDefinition(options: Array<{ value: string; text: string }>) {
  return {
    id: 'diag-form', name: 'Diagnose', version: '1.0.0',
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    bindings: {},
    layout: {
      type: 'form',
      children: [{
        id: 'condition', type: 'input-select', label: 'Zustand', uiElement: 'Autocomplete',
        binding: { templateAlias: 'diag', path: '/content/data/items[at0099]', rmType: 'DV_CODED_TEXT' },
        options,
      }],
    },
  } as const;
}

const MANY_OPTIONS = [
  { value: 'a1', text: 'Diabetes mellitus Typ 1' },
  { value: 'a2', text: 'Diabetes mellitus Typ 2' },
  { value: 'a3', text: 'Hypertonie' },
  { value: 'a4', text: 'Asthma bronchiale' },
];

describe('FormRuntime Autocomplete widget', () => {
  it('shows nothing selected initially and opens a full option list on focus', async () => {
    render(<FormRuntime definition={autocompleteDefinition(MANY_OPTIONS) as any} showSubmit={false} showHeader={false} />);
    const input = screen.getByPlaceholderText('Suchen …');
    expect(input).toHaveValue('');
    fireEvent.focus(input);
    expect(await screen.findByText('Diabetes mellitus Typ 1')).toBeInTheDocument();
    expect(screen.getByText('Hypertonie')).toBeInTheDocument();
  });

  it('typing filters the list by text, case-insensitively', async () => {
    render(<FormRuntime definition={autocompleteDefinition(MANY_OPTIONS) as any} showSubmit={false} showHeader={false} />);
    const input = screen.getByPlaceholderText('Suchen …');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'mellitus typ 2' } });
    await waitFor(() => {
      expect(screen.getByText('Diabetes mellitus Typ 2')).toBeInTheDocument();
      expect(screen.queryByText('Diabetes mellitus Typ 1')).not.toBeInTheDocument();
      expect(screen.queryByText('Hypertonie')).not.toBeInTheDocument();
    });
  });

  it('a query matching nothing shows "Keine Treffer" instead of an empty list', async () => {
    render(<FormRuntime definition={autocompleteDefinition(MANY_OPTIONS) as any} showSubmit={false} showHeader={false} />);
    const input = screen.getByPlaceholderText('Suchen …');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'völlig unbekannt xyz' } });
    expect(await screen.findByText('Keine Treffer')).toBeInTheDocument();
  });

  it('clicking an option selects it, closes the list, and reports the code as the value', async () => {
    const onValuesChange = vi.fn();
    render(<FormRuntime definition={autocompleteDefinition(MANY_OPTIONS) as any} showSubmit={false} showHeader={false} onValuesChange={onValuesChange} />);
    const input = screen.getByPlaceholderText('Suchen …');
    fireEvent.focus(input);
    fireEvent.mouseDown(await screen.findByText('Hypertonie'));
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({ condition: 'a3' })));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('an already-selected value shows its resolved text, not the raw code, when the list is closed', () => {
    render(<FormRuntime definition={autocompleteDefinition(MANY_OPTIONS) as any} initialValues={{ condition: 'a4' } as any} showSubmit={false} showHeader={false} />);
    expect(screen.getByPlaceholderText('Suchen …')).toHaveValue('Asthma bronchiale');
  });

  it('the clear button removes the selection', async () => {
    const onValuesChange = vi.fn();
    render(<FormRuntime definition={autocompleteDefinition(MANY_OPTIONS) as any} initialValues={{ condition: 'a4' } as any} showSubmit={false} showHeader={false} onValuesChange={onValuesChange} />);
    fireEvent.click(screen.getByLabelText('Auswahl löschen'));
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({ condition: undefined })));
  });

  it('Enter selects the currently highlighted option via the keyboard', async () => {
    const onValuesChange = vi.fn();
    render(<FormRuntime definition={autocompleteDefinition(MANY_OPTIONS) as any} showSubmit={false} showHeader={false} onValuesChange={onValuesChange} />);
    const input = screen.getByPlaceholderText('Suchen …');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'asthma' } });
    await screen.findByText('Asthma bronchiale');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({ condition: 'a4' })));
  });

  it('a field with zero enumerable options degrades to a plain free-text input rather than a permanently empty search box', () => {
    render(<FormRuntime definition={autocompleteDefinition([]) as any} showSubmit={false} showHeader={false} />);
    expect(screen.queryByPlaceholderText('Suchen …')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Freitext eingeben …')).toBeInTheDocument();
  });
});
