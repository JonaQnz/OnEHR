import { useEffect } from 'react';

/**
 * Sets the browser tab title for the page this is called from - "OnEHR"
 * alone for a page with nothing more specific to say, "<title> · OnEHR"
 * once it has something dynamic to show (a form name, a patient, an id).
 * Every page that calls this with a changing `title` (e.g. once a form or
 * patient record has loaded) gets a tab label that actually distinguishes
 * it from every other OnEHR tab open at the same time, instead of every
 * tab reading the same static string.
 *
 * `skip` is for a page component that's sometimes mounted embedded inside
 * another page (not routed to directly) - the embedding host already owns
 * the document title then, and this instance touching it too would just
 * make the two fight over it. Kept as a hook option rather than a
 * conditional hook call so the call site stays unconditional either way.
 */
export function useDocumentTitle(title?: string, options?: { skip?: boolean }): void {
  useEffect(() => {
    if (options?.skip) return;
    document.title = title ? `${title} · OnEHR` : 'OnEHR';
  }, [title, options?.skip]);
}
