import { useEffect } from 'react';

/**
 * Sets the browser tab title for the page this is called from - "OnEHR"
 * alone for a page with nothing more specific to say, "<title> · OnEHR"
 * once it has something dynamic to show (a form name, a patient, an id).
 * Every page that calls this with a changing `title` (e.g. once a form or
 * patient record has loaded) gets a tab label that actually distinguishes
 * it from every other OnEHR tab open at the same time, instead of every
 * tab reading the same static string.
 */
export function useDocumentTitle(title?: string): void {
  useEffect(() => {
    document.title = title ? `${title} · OnEHR` : 'OnEHR';
  }, [title]);
}
