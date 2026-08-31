import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import CompositionRuntime from './CompositionRuntime';
import { AuthStateContext, type AuthState } from '../App';

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
