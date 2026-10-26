# Vital Signs Demo Data Generator

A standalone tool that simulates a vital-signs scenario over time (heart
rate, respiration rate, SpO2, body temperature, blood pressure) and submits
it as a series of real openEHR Compositions to EHRbase, via this repo's
onEHR Forms HTTP API - not a different write path, the same API a browser
session or the `formbuilder-mcp-server` uses.

Lives outside the main npm workspace on purpose: it talks to the Forms API
purely over HTTP, the way any external client would, rather than importing
`core`/`openehr-engine` by source.

## Architecture

```
Simulation Model  ->  openEHR Adapter  ->  Composition (via Forms HTTP API)
(engine/*, no          (engine/openehrAdapter/*,     (backend/src/formsApiClient.ts,
 openEHR knowledge)      only file that knows          engine/submission/*)
                         at-codes/field ids)
```

- **`backend/src/engine/timeline.ts`** - turns a `Scenario` (start time,
  duration, default sampling interval, tracks) into an ordered list of
  `Timepoint`s, each `{ timestamp, dueTracks }`. Pure, synchronous, shared
  by the dry-run preview, the real generation run, and the tests.
- **`backend/src/engine/signalModels/*`** - `constant` / `randomWalk`
  (smoothed, mean-reverting - not independent `random(min,max)` per point)
  / `drawnCurve` (piecewise-linear interpolation between user-placed
  points), plus a shared `noise` layer. Registered in `index.ts` so a
  future model type (a "Preset/Pattern") plugs in without touching
  `timeline.ts`.
- **`backend/src/engine/tracks/*`** - one entry per vital-sign track type.
  `bloodPressure.ts` is the one coupled track: a single hemodynamic-tone
  signal drives both systolic and diastolic, with MAP/pulse-pressure always
  derived, never independently modeled.
- **`backend/src/engine/openehrAdapter/vitalSignsAdapter.ts`** - the *only*
  file that knows any openEHR at-code or Form Section field id. Translates
  one abstract `Timepoint` into the `Record<fieldId, RuntimeValue>` body a
  `PATCH /api/form-sessions/:id` expects.
- **`backend/src/engine/submission/*`** - `dryRun.ts` (zero HTTP calls,
  backs the preview chart and the tests) and `compositionRunner.ts` (the
  real per-timepoint composition-session/form-session/patch/submit loop
  against the Forms API).

Deliberately not built yet (documented seams only, see code comments):
**Events** (would sit between signal-model evaluation and the adapter call
in `timeline.ts`), **Presets** (a named bundle of per-track signal-model
configs + an event list), further **correlated tracks** (follow
`bloodPressure`'s pattern), and **History/Batch mode** (one OBSERVATION
per track holding a full multi-event HISTORY instead of one Composition
per timepoint) - the last one is blocked on core-engine support that does
not exist yet (see `packages/openehr-engine/src/canonicalComposition.ts`,
`buildObservationData`: an OBSERVATION's HISTORY always holds exactly one
event today).

## Prerequisites

- The onEHR Forms API running and reachable (`FORMS_API_URL`, default
  `http://localhost:3001`).
- A Forms account with at least the `USER` role (needs `form.execute`,
  `form-session.read-own`/`write-own`, `composition.read`/`write`,
  `patient.search`/`read`) - credentials via `FORMS_USERNAME`/
  `FORMS_PASSWORD` env vars.
- The published "Vitalzeichen" Form Section and "Vitalzeichen-Erfassung"
  Composition (see repo root for how these were built via the
  `formbuilder` MCP tools) - their ids go in `FORMS_VITALS_FORM_ID` /
  `FORMS_VITALS_COMPOSITION_FORM_ID`.

## Running

```sh
cd vital-signs-generator
npm install
npm run build:backend
npm run test:backend      # signal-model + timeline + adapter unit tests, no live stack needed
npm run dev:backend       # starts the local Express backend (holds the Forms-API session, runs the engine)
npm run dev:frontend      # starts the Vite dev server (scenario/track UI, calls the local backend only)
```

The frontend never calls the Forms API directly - only the local backend
does, which avoids the CORS/cookie issues a pure browser client would hit
against `apps/api`.
