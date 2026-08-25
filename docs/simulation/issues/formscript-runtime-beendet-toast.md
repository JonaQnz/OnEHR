Category: bug

**Status: fixed.** `FormScriptClient.destroy()` (`apps/web/src/scripting/runtime/FormScriptClient.ts`)
now rejects any lifecycle request still pending at teardown with a
`DOMException(..., 'AbortError')` instead of a plain `Error` - matching the
convention `formScript.worker.ts`'s own `cancelRuntimeTasks()` already uses
for its teardown-cancelled API requests. `FormRuntime.tsx`'s
`ready().then(...).catch(...)` chain now checks `error.name === 'AbortError'`
and swallows it silently, only surfacing a toast for genuine script
failures. Verified live: repeatedly switched FormBuilder's Designer/Preview
tabs on a form with a compiled formScript - no more error banner on mount.

## What I was trying to do

Adding a patient-context switcher to FormBuilder's Preview tab (the actual
"Preview" nav tab, `previewMode === 'runtime'`, which renders the real
`FormRuntime` - not the separate hand-rolled "Clinical Preview" split-pane
in the Designer view) so AQL-prefill can be tested there against real
patient data without leaving for SessionRuntime/LiveForm.

## What happened

As soon as the patient-context switcher's default patient/EHR-ID had
loaded and `FormRuntime` mounted, every single switch into the Preview tab
(on any form with a compiled formScript) showed a red error banner: "Form
Script Runtime wurde beendet." - even on a form with no AQL prefill
configured at all, and even on a completely vanilla load with no user
interaction.

Root cause: `FormRuntime.tsx`'s script-client effect kicks off
`client.ready().then(() => runLifecycle('beforeLoad')).then(() =>
runLifecycle('afterLoad'))` on mount, and tears the client down via
`client.destroy(...)` on cleanup. `destroy()` force-rejects any lifecycle
request still in flight at that point with a plain `Error('Form Script
Runtime wurde beendet.')`, which the `.catch()` on the mount chain turns
into a user-visible error toast - with no way to tell "this was torn down
on purpose" apart from "the script actually failed."

That distinction matters because React 18 `StrictMode` (enabled in
`main.tsx`) deliberately double-invokes effects in dev - mount, cleanup,
mount again - specifically to catch effects that aren't cleanup-safe. This
effect wasn't: the first mount's in-flight `ready`/`beforeLoad` promise gets
force-rejected by the simulated cleanup's `destroy()` call, and that
rejection's toast persists on the component even after the second (real)
mount succeeds cleanly. The same race is real (if rarer) in production too,
any time a user navigates away from a form mid-load.

## What I expected

Preview to load silently when there's nothing actually wrong, the same way
it now does after the fix.

## Fix applied

- `FormScriptClient.destroy()`: reject leftover pending requests with a
  `DOMException(..., 'AbortError')` instead of a plain `Error`, so callers
  can distinguish intentional teardown from a real failure.
- `FormRuntime.tsx`'s mount-time `.catch()`: skip the toast when
  `error.name === 'AbortError'`.

Scoped narrowly to the one reproducible path (the initial
ready/beforeLoad/afterLoad chain). `submit()`'s `runLifecycle` calls
(`onValidation`, `beforeSubmit`, `afterSubmit`) and `validate()` aren't
wrapped the same way and weren't touched - they're not hit by this race
since they only run while the component is mounted and the user is actively
submitting.
