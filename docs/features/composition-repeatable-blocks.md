# Runtime-repeatable Composition blocks ("+"-button)

Some Composition/Form Section combinations aren't a fixed 1:1 - a discharge
letter might need one, two, or five Diagnose entries depending on the
patient, or zero/one/several Befund entries. Before this feature, a
Composition could only offer a *fixed* number of instances of the same Form
Section (a designer could pre-place several "Nebendiagnose" blocks on a
page, but that number was baked in at design time). This document covers
the runtime alternative: a block a clinician grows on demand via a "+"
button, as many times as needed, with no auto-start and no upper limit.

## Design-time: opting a block in

`CompositionFormBlock` (`packages/core/src/composition/index.ts`) gained two
optional fields, both **off by default** - every existing Composition's
blocks keep auto-starting exactly as before, with zero behavior change:

- `manualAdd?: boolean` - when `true`, this block is never auto-started
  when its page loads. The runtime shows a "+ `<title>` hinzufügen" control
  instead; a clinician can click it as many times as they want, each click
  creating one more independent instance.
- `requireAtLeastOne?: boolean` - only meaningful when `manualAdd` is
  `true` (rejected by `normalizeCompositionDefinition` otherwise). When
  `true`, the composition session's progress panel shows one outstanding
  "not started" entry for this block until at least one instance exists,
  and `validateCompositionSession`/the grouped save block on it exactly
  like any other unmet requirement. Off by default: an ordinary `manualAdd`
  block is fully optional, the clinician may leave it untouched.

Toggled per block in `CompositionBuilder.tsx`'s form-block settings panel,
under "Manuell hinzufügen (+) statt automatisch starten".

## Data model: `childSessionGroups`

`CompositionSession.childSessions` (`Record<blockId, sessionId>`) remains
the storage for every ordinary block - untouched, still strictly 1:1. A
`manualAdd` block never has an entry there. Instead a new column,
`childSessionGroups: Record<blockId, sessionId[]>`, holds the ordered list
of every instance's FormSession id for that block - zero, one, or many.
Non-`manualAdd` blocks never have an entry here either. The two maps are
mutually exclusive per block, which keeps every existing 1:1 consumer
(`clinicalTransactionService`, the compact-summary UI, etc.) working
against `childSessions` completely unaware anything changed.

`compositionSessionService.publicSession()` flattens both maps into one
`children: ChildSummary[]` list for the API response - a `manualAdd` block
contributes one entry per existing instance (tagged `manualAdd: true` and
a 1-based `instanceIndex`), or a single synthetic not-started entry if
`requireAtLeastOne` and no instance exists yet, or nothing at all if
optional and untouched. `summarizeCompositionSession` (unchanged) derives
progress/status from this flat list exactly as before - it has no idea
some blocks contributed more than one entry.

## API

- `POST /api/composition-sessions/:id/blocks/:blockId/instances` -
  attaches one more instance (`{ childSessionId }`). Rejects (422) if the
  block isn't `manualAdd`. Re-posting an already-attached id is a no-op,
  not a duplicate (same optimistic-concurrency retry-once pattern as the
  existing attach endpoint).
- `DELETE /api/composition-sessions/:id/blocks/:blockId/instances/:childSessionId` -
  detaches one instance. Metadata-only: never deletes the underlying
  FormSession row (harmless to leave orphaned; a future cleanup pass could
  sweep those). Rejects (409) if that instance's FormSession is already
  `submitted` - once real clinical data has been saved, removing it from
  the Composition would silently hide, not undo, that save.
- The existing `PUT /api/composition-sessions/:id/blocks/:blockId` (single,
  overwriting attach) now rejects (422) a `manualAdd` block outright - it
  only ever grows through the `.../instances` endpoint, never through the
  plain 1:1 path, so a caller bug there fails loudly instead of silently
  clobbering an instance list.

## Runtime UI

`CompositionRuntime.tsx`'s `startBlocks()` skips `manualAdd` blocks
entirely on its own auto-start pass; a separate branch resume-mounts every
*already-existing* instance (so a page revisit doesn't lose previously
added entries) without ever creating a new one. Only the explicit
"+ hinzufügen" click (`addManualInstance`) launches a fresh FormSession and
attaches it as a new instance. Each rendered instance gets its own small
card (own iframe, own status badge, own "✕ entfernen" control - disabled
once that instance is `submitted`).

## What's deliberately out of scope (for now)

- No bulk reorder/renumber of instances - they're always shown in
  attach order.
- No server-side cleanup of a removed instance's now-orphaned FormSession
  row - it just stops being referenced by the Composition. Harmless (never
  submitted, never visible again), but not swept.
