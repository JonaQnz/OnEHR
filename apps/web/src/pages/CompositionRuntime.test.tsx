import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CompositionRuntime from './CompositionRuntime';
import CompositionRuntimeRoute from './CompositionRuntimeRoute';
import { AuthStateContext, type AuthState } from '../App';
import { activateCompositionDataCacheScope, clearCompositionDataCache, compositionSessionScope, loadCachedBlockData, saveCachedBlockData } from '../integration/compositionDataCache';

// CompositionRuntime reads useAuth() (to scope its client-side data cache
// per user) - App.tsx's useAuth() throws "Auth state unavailable" outside
// a real <AuthGate>, so every render below needs this mock provider.
const mockAuthState: AuthState = { loading: false, authenticated: true, mode: 'local', user: { id: 'test-user', displayName: 'Test User', authSource: 'local' }, roles: ['USER'], permissions: ['form.execute'], reload: async () => {} };
function renderWithAuth(ui: React.ReactElement) {
  return render(<AuthStateContext.Provider value={mockAuthState}>{ui}</AuthStateContext.Provider>);
}

// Covers the component-only refactor: CompositionRuntime takes every bit of
// context as props (formId/initial*/embedded/returnUrl/forceNew) and reads
// the router nowhere - the standalone /compositions/:id route goes through
// CompositionRuntimeRoute, which owns useParams/useSearchParams, while an
// embedding host (PatientDetail) mounts CompositionRuntime directly. Both
// paths have to keep working.

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
          <Route path="/compositions/:id" element={<CompositionRuntimeRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Klinisches Cockpit')).toBeInTheDocument());
    expect(screen.getByText('Zurück zur Patientenakte')).toBeInTheDocument();
  });
});

// The standalone /compositions/:id route now reads the URL in
// CompositionRuntimeRoute and hands everything to CompositionRuntime as
// props - routed launches must keep working (query mode, returnUrl, patient
// context), while an embedding host's own route/query string must not leak
// into the runtime.
describe('CompositionRuntimeRoute routing', () => {
  const ROUTE_FORM_ID = 'routed-1';

  function stubRoutedBackend() {
    const postBodies: Array<{ patientId?: string; mode?: string; forceNew?: boolean }> = [];
    const composition = {
      id: ROUTE_FORM_ID,
      name: 'Routentest',
      canonical_json: {
        extensions: {
          'watehr.composition': {
            schemaVersion: '1.0',
            pages: [{ id: 'page-1', title: 'Übersicht', blocks: [] }],
          },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/forms/${ROUTE_FORM_ID}`)) return jsonResponse(composition);
      if (url.endsWith('/patients')) return jsonResponse([]);
      if (url.endsWith('/composition-sessions') && init?.method === 'POST') {
        const body = JSON.parse((init.body as string) || '{}');
        postBodies.push(body);
        return jsonResponse({ id: 'routed-session-1', patientId: body.patientId ?? 'p1', mode: body.mode, status: 'draft', childSessions: {}, children: [], progress: { total: 0, started: 0, ready: 0, submitted: 0 } });
      }
      if (url.includes('/composition-sessions/')) return jsonResponse({ id: 'routed-session-1', patientId: 'p1', mode: 'create', status: 'draft', childSessions: {}, children: [], progress: { total: 0, started: 0, ready: 0, submitted: 0 } });
      return jsonResponse({});
    }));
    return postBodies;
  }

  it('routed: query mode=view, returnUrl and patient context reach the runtime', async () => {
    const postBodies = stubRoutedBackend();
    renderWithAuth(
      <MemoryRouter initialEntries={[`/compositions/${ROUTE_FORM_ID}?patientId=p1&ehrId=ehr1&mode=view&returnUrl=/patients/x`]}>
        <Routes>
          <Route path="/compositions/:id" element={<CompositionRuntimeRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Routentest')).toBeInTheDocument());
    await waitFor(() => expect(postBodies.length).toBeGreaterThan(0));
    expect(postBodies[0].mode).toBe('view');
    expect(postBodies[0].patientId).toBe('p1');
    expect(screen.getByText('Zurück zur Patientenakte').closest('a')).toHaveAttribute('href', '/patients/x');
  });

  it('routed: returnUrl //evil is rejected', async () => {
    stubRoutedBackend();
    renderWithAuth(
      <MemoryRouter initialEntries={[`/compositions/${ROUTE_FORM_ID}?patientId=p1&ehrId=ehr1&returnUrl=//evil`]}>
        <Routes>
          <Route path="/compositions/:id" element={<CompositionRuntimeRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Routentest')).toBeInTheDocument());
    expect(screen.getByText('Zurück zur Patientenakte').closest('a')).toHaveAttribute('href', '/');
  });

  it('embedded: host route query (?mode=view&forceNew=true) is ignored', async () => {
    const postBodies = stubRoutedBackend();
    renderWithAuth(
      <MemoryRouter initialEntries={['/patients/some-other-id?mode=view&forceNew=true']}>
        <Routes>
          <Route
            path="/patients/:id"
            element={<CompositionRuntime formId={ROUTE_FORM_ID} initialPatientId="p1" initialEhrId="ehr1" embedded />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Routentest')).toBeInTheDocument());
    await waitFor(() => expect(postBodies.length).toBeGreaterThan(0));
    expect(postBodies[0].mode).toBe('create');
    expect(postBodies[0].forceNew).toBe(false);
  });
});

// Covers the composition-data in-memory cache wiring end to end at the
// component level (see docs/features/composition-data-cache.md). The
// volatile cache only lives for the current authenticated page session, is
// scoped by session + full clinical context, and every fetch replaces the
// block's rows completely instead of merging an incremental delta.
describe('CompositionRuntime data cache wiring', () => {
  const DATA_FORM_ID = 'data-cache-1';
  const sessionScope = compositionSessionScope(mockAuthState);
  const blockContext = { sessionScope, formId: DATA_FORM_ID, blockId: 'block-labor', patientId: 'p1', namespace: '', ehrId: 'ehr1' };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  }

  function stubBackendWithDataBlock(compositionDataHandler: (body: any) => Promise<Response>) {
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
      if (url.endsWith('/composition-sessions') && init?.method === 'POST') {
        const body = JSON.parse((init.body as string) || '{}');
        return jsonResponse({ ...session, patientId: body.patientId, mode: body.mode || session.mode });
      }
      if (url.includes(`/composition-sessions/${session.id}`)) return jsonResponse(session);
      if (url.endsWith(`/forms/${DATA_FORM_ID}/composition-data`)) return compositionDataHandler(JSON.parse((init?.body as string) || '{}'));
      return jsonResponse({});
    }));
  }

  afterEach(() => { localStorage.clear(); clearCompositionDataCache(); });

  it('paints instantly from the in-memory cache, sends no `since`, and fully replaces rows on fetch', async () => {
    activateCompositionDataCacheScope(sessionScope);
    saveCachedBlockData(blockContext, { rows: [{ analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' }, { analyt: 'OnlyCached', wert: 7 }] });
    const compositionDataCalls: any[] = [];
    const response = deferred<Response>();
    stubBackendWithDataBlock(async (body) => {
      compositionDataCalls.push(body);
      return response.promise;
    });

    renderWithAuth(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route path="/x" element={<CompositionRuntime formId={DATA_FORM_ID} initialPatientId="p1" initialEhrId="ehr1" embedded />} />
        </Routes>
      </MemoryRouter>,
    );

    // Instant paint from the cache - before the network round trip resolves.
    await waitFor(() => expect(screen.getByText('14')).toBeInTheDocument());
    expect(screen.getByText('OnlyCached')).toBeInTheDocument();
    await waitFor(() => expect(compositionDataCalls.length).toBeGreaterThan(0));
    // No incremental cursor any more: every load transfers the full result.
    expect(compositionDataCalls[0].since).toBeUndefined();

    response.resolve(jsonResponse({ blockId: 'block-labor', rows: [{ analyt: 'Hb', wert: 13.2, recordedAt: '2026-08-21T08:00:00Z' }] }));

    await waitFor(() => expect(screen.getByText('13.2')).toBeInTheDocument());
    // Replaced, not merged: the cached-only row and the old Hb value are gone.
    expect(screen.queryByText('OnlyCached')).not.toBeInTheDocument();
    expect(screen.queryByText('14')).not.toBeInTheDocument();
    expect(loadCachedBlockData(blockContext)?.rows).toEqual([{ analyt: 'Hb', wert: 13.2, recordedAt: '2026-08-21T08:00:00Z' }]);
  });

  it('surfaces a corrected value even when its timestamp is unchanged', async () => {
    activateCompositionDataCacheScope(sessionScope);
    const recordedAt = '2026-08-20T08:00:00Z';
    saveCachedBlockData(blockContext, { rows: [{ analyt: 'Hb', wert: 14, recordedAt }] });
    stubBackendWithDataBlock(async () => jsonResponse({ blockId: 'block-labor', rows: [{ analyt: 'Hb', wert: 14.2, recordedAt }] }));

    renderWithAuth(
      <MemoryRouter initialEntries={['/x']}>
        <Routes>
          <Route path="/x" element={<CompositionRuntime formId={DATA_FORM_ID} initialPatientId="p1" initialEhrId="ehr1" embedded />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('14.2')).toBeInTheDocument());
    expect(screen.queryByText('14')).not.toBeInTheDocument();
    expect(loadCachedBlockData(blockContext)?.rows).toEqual([{ analyt: 'Hb', wert: 14.2, recordedAt }]);
  });

  it('ignores a late response from a previous patient/namespace after a switch', async () => {
    const oldRequest = deferred<Response>();
    const calls: any[] = [];
    stubBackendWithDataBlock(async (body) => {
      calls.push(body);
      if (body.patient.id === 'p1') return oldRequest.promise;
      return jsonResponse({ blockId: 'block-labor', rows: [{ analyt: 'Hb', wert: 'p2-new', recordedAt: '2026-08-22T08:00:00Z' }] });
    });

    renderWithAuth(
      <MemoryRouter initialEntries={[`/compositions/${DATA_FORM_ID}`]}>
        <Routes>
          <Route path="/compositions/:id" element={<CompositionRuntimeRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    const patientInput = await screen.findByPlaceholderText('Patient-ID / EHR-ID');
    fireEvent.change(patientInput, { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'ns1' } });
    fireEvent.change(screen.getByLabelText('EHR-ID (optional)'), { target: { value: 'ehr1' } });
    await waitFor(() => expect(calls.some((body) => body.patient.id === 'p1')).toBe(true));

    // Switch to a different patient *and* namespace while the old request is
    // still in flight. Its response must not repopulate the UI or the cache.
    fireEvent.change(patientInput, { target: { value: 'p2' } });
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'ns2' } });
    await waitFor(() => expect(screen.getByText('p2-new')).toBeInTheDocument());

    oldRequest.resolve(jsonResponse({ blockId: 'block-labor', rows: [{ analyt: 'Hb', wert: 'p1-stale', recordedAt: '2026-08-23T08:00:00Z' }] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText('p1-stale')).not.toBeInTheDocument();
    expect(loadCachedBlockData({ ...blockContext, namespace: 'ns1' })).toBeUndefined();
    expect(loadCachedBlockData({ ...blockContext, patientId: 'p2', namespace: 'ns2' })?.rows).toEqual([{ analyt: 'Hb', wert: 'p2-new', recordedAt: '2026-08-22T08:00:00Z' }]);
  });

  it('keeps the previous cache entry isolated when only the namespace changes', async () => {
    const oldRequest = deferred<Response>();
    const calls: any[] = [];
    stubBackendWithDataBlock(async (body) => {
      calls.push(body);
      if (body.patient.namespace === 'ns1') return oldRequest.promise;
      return jsonResponse({ blockId: 'block-labor', rows: [{ analyt: 'Hb', wert: 'ns2-new', recordedAt: '2026-08-22T08:00:00Z' }] });
    });

    renderWithAuth(
      <MemoryRouter initialEntries={[`/compositions/${DATA_FORM_ID}`]}>
        <Routes>
          <Route path="/compositions/:id" element={<CompositionRuntimeRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    const patientInput = await screen.findByPlaceholderText('Patient-ID / EHR-ID');
    fireEvent.change(patientInput, { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'ns1' } });
    fireEvent.change(screen.getByLabelText('EHR-ID (optional)'), { target: { value: 'ehr1' } });
    await waitFor(() => expect(calls.some((body) => body.patient.namespace === 'ns1')).toBe(true));

    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'ns2' } });
    await waitFor(() => expect(screen.getByText('ns2-new')).toBeInTheDocument());

    oldRequest.resolve(jsonResponse({ blockId: 'block-labor', rows: [{ analyt: 'Hb', wert: 'ns1-stale', recordedAt: '2026-08-23T08:00:00Z' }] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText('ns1-stale')).not.toBeInTheDocument();
    expect(loadCachedBlockData({ ...blockContext, namespace: 'ns1' })).toBeUndefined();
  });

  it('fetches everything on a genuinely first load and stores the result', async () => {
    const compositionDataCalls: any[] = [];
    stubBackendWithDataBlock(async (body) => {
      compositionDataCalls.push(body);
      return jsonResponse({ blockId: 'block-labor', rows: [{ analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' }] });
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
    expect(loadCachedBlockData(blockContext)?.rows).toEqual([{ analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' }]);
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
