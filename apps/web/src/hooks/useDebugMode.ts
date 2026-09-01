import { useCallback, useEffect, useState } from 'react';

/**
 * Global "debug mode" switch, toggled from the sidebar (see App.tsx) and
 * read wherever a debug-only affordance should show - currently the
 * Patient Detail "Debug" tab (integration call log download, see
 * PatientDetail.tsx). Persisted to localStorage so it survives reloads;
 * broadcasts a same-tab custom event on change so every mounted consumer
 * (not just the one that toggled it) updates immediately - a plain
 * `storage` event only fires in *other* tabs, never the one that made the
 * change.
 */
const STORAGE_KEY = 'formbuilder.debugMode';
const EVENT_NAME = 'formbuilder:debug-mode-changed';

function readStoredDebugMode(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setDebugMode(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Private browsing / storage disabled - the toggle just won't persist.
  }
  window.dispatchEvent(new CustomEvent<boolean>(EVENT_NAME, { detail: value }));
}

export function useDebugMode(): [boolean, (value: boolean) => void] {
  const [debugMode, setDebugModeState] = useState(readStoredDebugMode);

  useEffect(() => {
    const onChange = (event: Event) => setDebugModeState((event as CustomEvent<boolean>).detail);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setDebugModeState(event.newValue === 'true');
    };
    window.addEventListener(EVENT_NAME, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const toggle = useCallback((value: boolean) => setDebugMode(value), []);
  return [debugMode, toggle];
}
