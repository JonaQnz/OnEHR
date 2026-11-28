import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Config from './Config';

// Config.tsx renders PluginSettingsHost at the bottom; that component reaches
// for plugin settings state the test does not care about here, so it is
// stubbed out to nothing - matching the render/fetch-stub pattern used by
// CompositionRuntime.test.tsx.
vi.mock('../components/PluginSettingsHost', () => ({ default: () => null }));

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Config cockpit form parent id', () => {
  it('cockpit line id input is labelled and bound', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/config')) {
        return jsonResponse({ ehrbaseConnections: [], patientCockpitFormParentId: 'line-1' });
      }
      return jsonResponse({});
    }));

    render(<Config />);

    // The page shows "Loading Configuration..." until the stubbed /config
    // fetch resolves, so the first label lookup has to wait.
    const input = await screen.findByLabelText('Patienten-Cockpit (Formular-Linien-ID)');
    expect(input).toHaveValue('line-1');

    // The label must resolve to the very same control that the textbox role
    // query finds by accessible name; without htmlFor/id they are unrelated.
    expect(screen.getByRole('textbox', { name: 'Patienten-Cockpit (Formular-Linien-ID)' })).toBe(input);

    fireEvent.change(input, { target: { value: 'line-2' } });
    expect(input).toHaveValue('line-2');
  });
});
