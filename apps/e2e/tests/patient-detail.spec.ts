import { test, expect, type Locator } from '@playwright/test';
import { createTestPatient } from './helpers';

/** page.waitForLoadState('networkidle') never resolves on this app - Vite's
 * dev server keeps a persistent HMR websocket open, which networkidle
 * waits to go quiet forever (a documented, common footgun, which is why
 * Playwright itself discourages relying on networkidle at all). Polls the
 * tab count instead until it stops changing across consecutive samples -
 * that's the actual thing worth waiting for here (see PatientDetail.tsx's
 * async-discovered Klinisches-Cockpit tab). */
async function waitForStableTabCount(tabs: Locator): Promise<number> {
  let previous = -1;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await tabs.count();
    if (current > 0 && current === previous) return current;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Tab count never stabilized (last seen: ${previous})`);
}

test('patient detail page: renders, tab bar is real and clickable, "Neues Formular" is reachable', async ({ page, request }) => {
  const patient = await createTestPatient(request);

  await page.goto(`/patients/${patient.id}`);
  await expect(page.getByRole('heading', { name: new RegExp(patient.firstName) })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Neues Formular' })).toBeVisible();

  // Scoped by its aria-label: once the Cockpit tab is showing, its own
  // embedded Composition content brings a SECOND role="tablist" (its own
  // page tabs, e.g. Übersicht/Zeitleiste/Labor) - a real, welcome sign the
  // native (non-iframe) embedding actually renders, but it means a bare
  // getByRole('tablist') is ambiguous on this page.
  const tabList = page.getByRole('tablist', { name: 'Bereiche der Patientenakte' });
  await expect(tabList).toBeVisible();
  // The tab set itself is not static: a "Klinisches Cockpit" tab gets
  // prepended once the (async) published-forms fetch resolves and finds
  // one, same as the very first tab may auto-switch once it does (see
  // PatientDetail.tsx). Reading labels before that settles, then clicking
  // by stale index, is exactly how this test first failed - waiting for
  // the tab count to stabilize first, then locating every tab by its
  // (now-stable) label rather than position, avoids depending on how many
  // tabs exist or in what order.
  await waitForStableTabCount(tabList.getByRole('tab'));
  const labels = await tabList.getByRole('tab').allTextContents();
  expect(labels.length).toBeGreaterThan(0);

  // Every tab actually switches the panel content, not just its own
  // highlighted state - clicking through each one exercises this session's
  // Klinisches-Cockpit-as-a-tab integration end to end (if that Form is
  // published in whatever environment runs this) alongside every other
  // tab. Once the Cockpit tab is active, its own embedded Composition page
  // tabs can share a label with an outer one (both happen to have an
  // "Übersicht") - locators stay scoped to the outer tablist so that never
  // becomes ambiguous.
  for (const label of labels) {
    const tab = tabList.getByRole('tab', { name: label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = page.getByRole('tabpanel');
    await expect(panel).toBeVisible();
    // A blank tabpanel would mean the click changed the tab strip's own
    // active state without actually rendering that tab's content - assert
    // there is *some* text, not particular text (content differs a lot
    // between "Dokumente" vs. an embedded Klinisches Cockpit).
    await expect(async () => {
      const text = (await panel.textContent())?.trim() ?? '';
      expect(text.length, `tab "${label}" rendered an empty panel`).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000 });
  }
});
