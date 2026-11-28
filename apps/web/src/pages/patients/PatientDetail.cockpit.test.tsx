import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PatientDetail from './PatientDetail';
import { AuthStateContext, type AuthState } from '../../App';

// PatientDetail mounts CompositionRuntime for the Cockpit tab - mocking it
// records every form it was actually handed, so a test can tell a Cockpit
// mounted during the runtime-defaults request (or after it failed) apart from
// the one the setting really selects.
const mounted = vi.hoisted(() => [] as string[]);
vi.mock('../CompositionRuntime', () => ({
  default: ({ formId }: { formId?: string }) => {
    mounted.push(String(formId));
    return <div data-testid="cockpit-runtime">{formId}</div>;
  },
}));

// PatientDetail reads useAuth() - App.tsx's useAuth() throws outside a real
// <AuthGate>, so every render needs this provider (same shape as
// CompositionRuntime.test.tsx).
const mockAuthState: AuthState = { loading: false, authenticated: true, mode: 'local', user: { id: 'test-user', displayName: 'Test User', authSource: 'local' }, roles: ['USER'], permissions: ['form.execute'], reload: async () => {} };

const COMPOSITION = { extensions: { 'watehr.composition': { schemaVersion: '1.0', pages: [] } } };
const form = (id: string, parent_id: string, name: string) => ({ id, parent_id, name, version: '1', status: 'published', createdAt: '2026-01-01T00:00:00.000Z', canonical_json: COMPOSITION });
const LEGACY = form('legacy-1', 'line-a', 'Klinisches Cockpit');
const LINE_B = form('cockpit-b-1', 'line-b', 'Cockpit B');
const PATIENT = { id: 'pat-1', patientId: 'P-1', firstName: 'Erika', lastName: 'Muster', ehrId: 'ehr-1', createdAt: '2026-01-01T00:00:00.000Z' };

interface Deferred {
  promise: Promise<Response>;
  resolve: (value: Response) => void;
}

function deferred(): Deferred {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

// GET /config/runtime-defaults is deliberately deferred: while it runs the
// Cockpit setting is "not loaded yet", which is exactly the state the fix has
// to treat differently from "loaded and empty".
function stubBackend(config: Deferred): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/config/runtime-defaults')) return config.promise;
    if (url.endsWith('/patients/pat-1')) return jsonResponse(PATIENT);
    if (url.endsWith('/forms')) return jsonResponse([LEGACY, LINE_B]);
    if (url.includes('/form-sessions') || url.includes('/composition-sessions') || url.endsWith('/compositions')) return jsonResponse([]);
    return jsonResponse({});
  }));
}

function renderPage(): void {
  render(
    <AuthStateContext.Provider value={mockAuthState}>
      <MemoryRouter initialEntries={['/patients/pat-1']}>
        <Routes>
          <Route path="/patients/:id" element={<PatientDetail />} />
        </Routes>
      </MemoryRouter>
    </AuthStateContext.Provider>,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function resolveSetting(config: Deferred, response: Response): Promise<void> {
  await act(async () => {
    config.resolve(response);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  mounted.length = 0;
});

describe('PatientDetail cockpit gating on runtime-defaults', () => {
  it('a: mounts no Cockpit while the runtime-defaults request is still pending', async () => {
    const config = deferred();
    stubBackend(config);
    renderPage();

    await screen.findByRole('tab', { name: 'Formulare und Dokumente' });
    await flush();

    expect(screen.queryByRole('tab', { name: 'Klinisches Cockpit' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('cockpit-runtime')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Formulare und Dokumente' })).toHaveAttribute('aria-selected', 'true');
    expect(mounted).toEqual([]);
  });

  it('b: mounts only the form of the configured line once loaded', async () => {
    const config = deferred();
    stubBackend(config);
    renderPage();

    await screen.findByRole('tab', { name: 'Formulare und Dokumente' });
    await flush();
    await resolveSetting(config, jsonResponse({ patientCockpitFormParentId: 'line-b' }));

    expect(await screen.findByTestId('cockpit-runtime')).toHaveTextContent('cockpit-b-1');
    expect(screen.getByRole('tab', { name: 'Klinisches Cockpit' })).toHaveAttribute('aria-selected', 'true');
    expect(mounted).not.toContain('legacy-1');
  });

  it('c: falls back to the documents tab when the configured line has no form', async () => {
    const config = deferred();
    stubBackend(config);
    renderPage();

    await screen.findByRole('tab', { name: 'Formulare und Dokumente' });
    await flush();
    await resolveSetting(config, jsonResponse({ patientCockpitFormParentId: 'line-x' }));

    expect(screen.queryByRole('tab', { name: 'Klinisches Cockpit' })).not.toBeInTheDocument();
    expect(mounted).toEqual([]);
    expect(screen.getByRole('tab', { name: 'Formulare und Dokumente' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).not.toBeEmptyDOMElement();
  });

  it('d: an empty setting keeps the legacy name match', async () => {
    const config = deferred();
    stubBackend(config);
    renderPage();

    await screen.findByRole('tab', { name: 'Formulare und Dokumente' });
    await flush();
    await resolveSetting(config, jsonResponse({ patientCockpitFormParentId: '' }));

    expect(await screen.findByTestId('cockpit-runtime')).toHaveTextContent('legacy-1');
  });

  it('e: stays on the documents tab when runtime-defaults fails', async () => {
    const config = deferred();
    stubBackend(config);
    renderPage();

    await screen.findByRole('tab', { name: 'Formulare und Dokumente' });
    await flush();
    await resolveSetting(config, { ok: false, status: 500, json: async () => ({}) } as Response);

    expect(screen.queryByRole('tab', { name: 'Klinisches Cockpit' })).not.toBeInTheDocument();
    expect(mounted).toEqual([]);
    expect(screen.getByRole('tab', { name: 'Formulare und Dokumente' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).not.toBeEmptyDOMElement();
  });
});
