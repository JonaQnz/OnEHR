import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CompositionRuntime from './CompositionRuntime';
import { AuthStateContext, type AuthState } from '../App';
import { compositionDataCacheKey, loadCachedBlockData, saveCachedBlockData } from '../integration/compositionDataCache';

// CompositionRuntime reads useAuth() (to scope its client-side data cache
// per user) - App.tsx's useAuth() throws "Auth state unavailable" outside
// a real <AuthGate>, so every render below needs this mock provider.
const mockAuthState: AuthState = { loading: false, authenticated: true, mode: 'local', user: { id: 'test-user', displayName: 'Test User', authSource: 'local' }, roles: ['USER'], permissions: ['form.execute'], reload: async () => {} };
function renderWithAuth(ui: React.ReactElement) {
  return render(<AuthStateContext.Provider value={mockAuthState}>{ui}</AuthStateContext.Provider>);
}

// Covers the prop-override refactor from the Klinisches-Cockpit embedding
// work: CompositionRuntime can now be mounted directly as a component
// (formId/initial*/embedded props) instead of only being routed to
// (useParams/useSearchParams) - both paths have to keep working, since the
// standalone /compositions/:id route still uses the unmounted-props path.

const FORM_ID = 'cockpit-1';

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function stubBackend() {
  const composition = {
    id: FORM_ID,
    name: 'Klinisches Cockpit',
    canonical_json: {
      extensions: {
        'watehr.composition': {
          schemaVersion: '1.0',
          pages: [{ id: 'page-1', title: 'Übersicht', blocks: [] }],
        },
      },
    },
  };
  const session = {
    id: 'session-1',
    patientId: 'p1',
    mode: 'create',
    status: 'draft',
    childSessions: {},
    children: [],
    progress: { total: 0, started: 0, ready: 0, submitted: 0 },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/forms/${FORM_ID}`)) return jsonResponse(composition);
    if (url.endsWith('/patients')) return jsonResponse([]);
    if (url.endsWith('/composition-sessions') && init?.method === 'POST') return jsonResponse(session);
    if (url.includes(`/composition-sessions/${session.id}`)) return jsonResponse(session);
    return jsonResponse({});
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CompositionRuntime embedding', () => {
  it('embedded: hides its own back-link and outer chrome, and formId overrides the route id', async () => {
    stubBackend();
    renderWithAuth(
      <MemoryRouter initialEntries={['/patients/some-other-id']}>
        <Routes>
          {/* Route param "id" deliberately does NOT match FORM_ID - proves
              the formId prop, not useParams(), wins when both are present. */}
          <Route
            path="/patients/:id"
            element={<CompositionRuntime formId={FORM_ID} initialPatientId="p1" initialEhrId="ehr1" embedded />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Klinisches Cockpit')).toBeInTheDocument());
    expect(screen.queryByText('Zurück zur Patientenakte')).not.toBeInTheDocument();
  });

  it('standalone route: shows its own back-link when not embedded', async () => {
    stubBackend();
    renderWithAuth(
      <MemoryRouter initialEntries={[`/compositions/${FORM_ID}?patientId=p1&ehrId=ehr1`]}>
        <Routes>
          <Route path="/compositions/:id" element={<CompositionRuntime />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Klinisches Cockpit')).toBeInTheDocument());
    expect(screen.getByText('Zurück zur Patientenakte')).toBeInTheDocument();
  });
});

// Covers the composition-data local-cache wiring end to end at the
// component level (see docs/features/composition-data-cache.md) - the
// pure-function tests in compositionDataCache.test.ts and
// composition-data-diff.test.js each cover their own half in isolation,
// but neither exercises refreshData() itself: cache-hit paint, the
// background fetch actually carrying `since`, and the merge back into
// both UI state and the cache.
describe('CompositionRuntime data cache wiring', () => {
  const DATA_FORM_ID = 'data-cache-1';
  const cacheKey = compositionDataCacheKey({ userId: 'test-user', formId: DATA_FORM_ID, blockId: 'block-labor', patientId: 'p1', ehrId: 'ehr1' });

  function stubBackendWithDataBlock(compositionDataHandler: (init?: RequestInit) => Promise<Response>) {
    const composition = {
      id: DATA_FORM_ID,
      name: 'Datentest',
      canonical_json: {
        extensions: {
          'watehr.composition': {
            schemaVersion: '1.0',
            pages: [{ id: 'page-1', title: 'Übersicht', blocks: [
              { id: 'block-labor', type: 'data', title: 'Labor', display: 'list', widgetId: 'w1', timeColumn: 'recordedAt' },
            ] }],
          },
        },
      },
    };
    const session = { id: 'session-data-1', patientId: 'p1', mode: 'create', status: 'draft', childSessions: {}, children: [], progress: { total: 0, started: 0, ready: 0, submitted: 0 } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/forms/${DATA_FORM_ID}`)) return jsonResponse(composition);
      if (url.endsWith('/patients')) return jsonResponse([]);
      if (url.endsWith('/composition-sessions') && init?.method === 'POST') return jsonResponse(session);
      if (url.includes(`/composition-sessions/${session.id}`)) return jsonResponse(session);
      if (url.endsWith(`/forms/${DATA_FORM_ID}/composition-data`)) return compositionDataHandler(init);
      return jsonResponse({});
    }));
  }

  afterEach(() => { localStorage.clear(); });

  it('paints instantly from a pre-existing cache, then merges an incrementally-fetched row using the cached `since` cursor', async () => {
    const cachedThrough = Date.parse('2026-08-20T08:00:00Z');
    saveCachedBlockData(cacheKey, { rows: [{ analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' }], cachedThrough });
    const compositionDataCalls: any[] = [];
    stubBackendWithDataBlock(async (init) => {
      compositionDataCalls.push(JSON.parse((init?.body as string) || '{}'));
      return jsonResponse({ blockId: 'block-labor', rows: [{ analyt: 'Hb', wert: 13.2, recordedAt: '2026-08-21T08:00:00Z' }], cachedThrough: Date.parse('2026-08-21T08:00:00Z') });
    });

    renderWithAuth(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route path="/x" element={<CompositionRuntime formId={DATA_FORM_ID} initialPatientId="p1" initialEhrId="ehr1" embedded />} />
        </Routes>
      </MemoryRouter>,
    );

    // Instant paint from the pre-seeded cache - the cached row is visible
    // (WidgetDataCard's "list" display renders it as a table cell) without
    // waiting on any network round trip to resolve.
    await waitFor(() => expect(screen.getByText('14')).toBeInTheDocument());
    // The background fetch actually asked for only what's new, using the
    // cache's own cachedThrough as `since` - not a blind full refetch.
    await waitFor(() => expect(compositionDataCalls.length).toBeGreaterThan(0));
    expect(compositionDataCalls[0].since).toBe(cachedThrough);
    // Once it resolves, the new row merges in alongside the cached one.
    await waitFor(() => expect(screen.getByText('13.2')).toBeInTheDocument());
    expect(screen.getByText('14')).toBeInTheDocument();
    // And the cache itself now reflects the merged set, ready for the next visit.
    const updated = loadCachedBlockData(cacheKey);
    expect(updated?.rows).toHaveLength(2);
    expect(updated?.cachedThrough).toBe(Date.parse('2026-08-21T08:00:00Z'));
  });

  it('fetches everything (no `since`) on a genuinely first load with nothing cached yet', async () => {
    const compositionDataCalls: any[] = [];
    stubBackendWithDataBlock(async (init) => {
      compositionDataCalls.push(JSON.parse((init?.body as string) || '{}'));
      return jsonResponse({ blockId: 'block-labor', rows: [{ analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' }], cachedThrough: Date.parse('2026-08-20T08:00:00Z') });
    });

    renderWithAuth(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route path="/x" element={<CompositionRuntime formId={DATA_FORM_ID} initialPatientId="p1" initialEhrId="ehr1" embedded />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('14')).toBeInTheDocument());
    await waitFor(() => expect(compositionDataCalls.length).toBeGreaterThan(0));
    expect(compositionDataCalls[0].since).toBeUndefined();
    expect(loadCachedBlockData(cacheKey)?.cachedThrough).toBe(Date.parse('2026-08-20T08:00:00Z'));
  });
});

// Covers the manualAdd ("+"-button) repeatable-block feature: a block
// flagged manualAdd in the Composition definition must never auto-start
// like an ordinary form block, must offer an explicit "+ hinzufügen"
// control instead, and clicking it must attach a new instance via the
// dedicated .../instances endpoint (which appends) rather than the plain
// PUT .../blocks/:blockId endpoint (which would overwrite).
describe('CompositionRuntime manualAdd (repeatable) blocks', () => {
  const MANUAL_FORM_ID = 'manual-add-1';

  function stubBackendWithManualBlock(sessionOverrides: Partial<Record<string, unknown>> = {}, requireAtLeastOne = false) {
    const composition = {
      id: MANUAL_FORM_ID,
      name: 'Entlassung',
      canonical_json: {
        extensions: {
          'watehr.composition': {
            schemaVersion: '1.0',
            pages: [{ id: 'page-1', title: 'Übersicht', blocks: [
              { id: 'diagnosis', type: 'form', formId: 'diagnosis-form', title: 'Diagnose', manualAdd: true, ...(requireAtLeastOne ? { requireAtLeastOne: true } : {}) },
            ] }],
          },
        },
      },
    };
    let session: any = { id: 'manual-session-1', patientId: 'p1', mode: 'create', status: 'draft', childSessions: {}, childSessionGroups: {}, children: [], progress: { total: 0, started: 0, ready: 0, submitted: 0 }, ...sessionOverrides };
    const launchCalls: any[] = [];
    const instanceCalls: any[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/forms/${MANUAL_FORM_ID}`)) return jsonResponse(composition);
      if (url.endsWith('/patients')) return jsonResponse([]);
      if (url.endsWith('/composition-sessions') && init?.method === 'POST') return jsonResponse(session);
      if (url.endsWith('/form-launches') && init?.method === 'POST') {
        launchCalls.push(JSON.parse((init.body as string) || '{}'));
        return jsonResponse({ session: { id: 'diag-instance-1' }, launchUrl: '/embed/forms/diagnosis-form?sessionId=diag-instance-1' });
      }
      if (url.includes(`/composition-sessions/${session.id}/blocks/diagnosis/instances`) && init?.method === 'POST') {
        instanceCalls.push(JSON.parse((init.body as string) || '{}'));
        session = { ...session, childSessionGroups: { diagnosis: ['diag-instance-1'] }, children: [{ blockId: 'diagnosis', sessionId: 'diag-instance-1', formId: 'diagnosis-form', status: 'in_progress', manualAdd: true, instanceIndex: 1 }], progress: { total: 1, started: 1, ready: 0, submitted: 0 } };
        return jsonResponse(session);
      }
      if (url.includes(`/composition-sessions/${session.id}`)) return jsonResponse(session);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    return { launchCalls, instanceCalls };
  }

  it('never auto-starts a manualAdd block - only an explicit "+ hinzufügen" control is offered', async () => {
    const { launchCalls } = stubBackendWithManualBlock();
    renderWithAuth(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route path="/x" element={<CompositionRuntime formId={MANUAL_FORM_ID} initialPatientId="p1" initialEhrId="ehr1" embedded />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Diagnose hinzufügen/i)).toBeInTheDocument());
    // No launch/attach happened just from opening the page - manualAdd
    // blocks are opt-in, never auto-created like an ordinary form block.
    expect(launchCalls.length).toBe(0);
    expect(screen.getByText('Noch kein Eintrag')).toBeInTheDocument();
  });

  it('clicking "+" launches and attaches a new instance via POST .../instances, not PUT .../blocks/:blockId', async () => {
    const { launchCalls, instanceCalls } = stubBackendWithManualBlock();
    renderWithAuth(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route path="/x" element={<CompositionRuntime formId={MANUAL_FORM_ID} initialPatientId="p1" initialEhrId="ehr1" embedded />} />
        </Routes>
      </MemoryRouter>,
    );
    const addButton = await screen.findByText(/Diagnose hinzufügen/i);
    fireEvent.click(addButton);

    await waitFor(() => expect(instanceCalls.length).toBe(1));
    expect(launchCalls.length).toBe(1);
    expect(instanceCalls[0]).toEqual({ childSessionId: 'diag-instance-1' });
    await waitFor(() => expect(screen.getByText('Diagnose #1')).toBeInTheDocument());
  });

  it('a block with requireAtLeastOne and zero instances shows the outstanding-required hint', async () => {
    stubBackendWithManualBlock({ children: [{ blockId: 'diagnosis', formId: 'diagnosis-form', status: 'not_started', manualAdd: true }], progress: { total: 1, started: 0, ready: 0, submitted: 0 } }, true);
    renderWithAuth(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route path="/x" element={<CompositionRuntime formId={MANUAL_FORM_ID} initialPatientId="p1" initialEhrId="ehr1" embedded />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Diagnose hinzufügen/i)).toBeInTheDocument());
    expect(screen.getByText('Noch kein Eintrag')).toBeInTheDocument();
    expect(screen.getByText(/mindestens 1 erforderlich/i)).toBeInTheDocument();
  });
});
