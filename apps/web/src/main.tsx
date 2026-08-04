import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

// The API runs on a different local origin in development (port 3001). Native
// fetch therefore omits the HttpOnly Forms session cookie unless each call
// specifies credentials. Keep that rule in one place for all Forms API calls.
const nativeFetch = window.fetch.bind(window);
const configuredApiOrigin = new URL(import.meta.env.VITE_API_URL || 'http://localhost:3001', window.location.origin).origin;

window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  // Keep the credentials policy of callers that pass a Request object intact.
  if (input instanceof Request) return nativeFetch(input, init);
  const url = typeof input === 'string' ? input : input.toString();
  const resolved = new URL(url, window.location.origin);
  const isFormsApi = url.startsWith('/api/') || resolved.origin === configuredApiOrigin;
  if (isFormsApi && init?.credentials === undefined) {
    return nativeFetch(input, { ...init, credentials: 'include' });
  }
  return nativeFetch(input, init);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
