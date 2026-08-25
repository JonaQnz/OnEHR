Category: bug

**Status: fixed.** `optionType()` in `packages/core/src/form-scripting/index.ts`
now builds the literal union from `option.value` (falling back to `text`
only when a value is missing), matching `validateOne()`. Existing published
forms keep their already-compiled `formScript.generatedTypes` until next
edited/republished; this only affects new/re-saved formScript compilations.

## What I was trying to do

Build and test the "Anordnung" form (bound to `vg_ServiceRequest.v1.1.1`).
Its `Dringlichkeit` (urgency) field is a proper `input-select` with options
`[{ text: "Notfall", value: "at0136" }, { text: "Dringend", value: "at0137" },
{ text: "Routine", value: "at0138" }]`. To fill a test session I looked at
the form's own compiled `formScript.generatedTypes` to see what value the
field expects:

```ts
"vg_servicerequest.v1.1.1_urgency": "Notfall" | "Dringend" | "Routine" | null;
```

So I set the session value to `"Notfall"` (matching the declared type
exactly).

## What happened

`validate_form_session` rejected it:

```
{ "path": "vg_servicerequest.v1.1.1_urgency", "code": "option",
  "message": "vg_servicerequest.v1.1.1_urgency contains an unsupported option." }
```

Only setting the value to the option's `value` (`"at0138"`, the at-code) -
not the `text` the generated TypeScript type promises - passed validation
and submitted successfully.

Traced it to a mismatch between two independent implementations that are
supposed to describe the same contract:

- `packages/core/src/form-scripting/index.ts`, `optionType()` (~line
  172-175):
  ```ts
  function optionType(node: FormElementLayout): string {
    const values = (node.options || []).map((option) => option.text || option.value);
    return values.length > 0 ? `${union(values)} | null` : 'string | null';
  }
  ```
  builds the `FormValues[fieldId]` literal union from each option's
  **`text`** (falling back to `value` only if `text` is missing).

- `packages/core/src/form-runtime/index.ts`, `validateOne()` (~line 168):
  ```ts
  if (selected.some((item) => typeof item !== 'string' || !field.options.some((option) => option.value === item))) issue(...)
  ```
  validates the actual runtime value against each option's **`value`**
  only.

So for any `input-select`/`input-ordinal` field whose option `text` and
`value` differ (which is any select whose options were hand-labelled with
a human-readable `text` distinct from the openEHR at-code `value` - e.g.
every coded-text field built the way Kontaktart/Bundesland/this form's
Dringlichkeit are), the compiled `formScript.generatedTypes` documents a
value shape that `validate_form_session`/`submit_form_session_to_provider`
will actually reject, and vice versa - the value the runtime accepts isn't
a valid literal per the generated type. A form script author (or, as here,
anyone reading the compiled types to figure out what to put in a session)
gets steered wrong every time text != value.

## What I expected

The declared `FormValues[fieldId]` type for a select field to match what
`validate_form_session` actually accepts - i.e. `optionType()` should build
its union from `option.value`, the same field `validateOne()` checks.

## Workaround taken for now

None needed for the Anordnung form itself - once I read the runtime
validator's source instead of trusting `generatedTypes`, filling the
session with `option.value` codes (`"at0138"` etc.) worked and the
composition submitted to EHRbase correctly (confirmed via AQL: urgency
lands as `defining_code/code_string = "at0138"`, `value = "Routine"`).
This is purely a compiled-type/runtime-validation mismatch, not a template
or binding problem - no change was made to the Anordnung form to work
around it.

## Suggested fix path (not attempted)

`packages/core/src/form-scripting/index.ts`, `optionType()`: change
`(option) => option.text || option.value` to `(option) => option.value`,
matching `form-runtime`'s `validateOne()`. (If `text` is kept as a fallback
for options with no `value`, the two functions should at least be sourced
from one shared helper so they can't drift again.)
