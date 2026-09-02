# openEHR RM Data Type spec conformance - concept & backlog

Started 2026-09-02 after auditing this codebase against the [openEHR RM
Data Types specification](https://specifications.openehr.org/releases/RM/latest/data_types.html)
and shipping fixes for DV_QUANTITY, DV_IDENTIFIER, DV_PROPORTION, and
DV_ORDINAL (PRs #42-#47). This document is the concept for continuing that audit
across the remaining RM data types - it lays out the method, what's
already done, and a grounded (not speculative) backlog of what's left,
each item checked against this codebase's actual code before being
listed here.

**Revision note**: the first draft of the backlog below was written
from general knowledge of the spec, not by reading it directly - asked
to double-check, a second pass actually fetched and read the real RM
Data Types IM and AOM2 specifications ([specifications.openehr.org](https://specifications.openehr.org/))
for every claim. One item was wrong: DV_TEXT's archetype constraint
mechanism is not a length range (there's no such thing at the RM/AOM
level) - it's `C_STRING`, a list of allowed literal strings or a regex
pattern. Corrected in-place below (#2), with the spec text quoted. The
other three items held up against the real spec text; DV_ORDINAL and
DV_DATE/TIME sections now also carry the exact spec quotes rather than
paraphrase.

## Why this exists as its own effort

A field can be *recognized* by this codebase (parsed, given its own
widget type, rendered) without being *correctly serialized* to the RM.
That gap is invisible until either someone reads the RM spec side by
side with the code, or a real submission hits EHRbase and gets rejected.
Three real, previously-undiscovered gaps of exactly this shape were
found and fixed this way in one afternoon (DV_QUANTITY's range/precision
silently dropped, DV_IDENTIFIER writing a bare string instead of `|id`,
DV_PROPORTION having no serialization branch at all). There is no reason
to assume the remaining RM types are cleaner - they've never been
checked the same way.

## Method (proven, repeat exactly)

1. **Read the spec section for the type** - RM Data Types IM plus, where
   relevant, the AOM (Archetype Object Model) for how an archetype
   constrains it. Note every invariant and every attribute with
   substructure (not just the "obvious" value).
2. **Grep this codebase for every place that type is handled** -
   `webTemplateParser.ts` (parsing/widget assignment), `formGenerator.ts`
   (generation), `openehr-engine/src/index.ts`'s `setFlatValue`/
   `readFlatValue` (FLAT path), `canonicalComposition.ts`'s
   `buildLeafDvValue` (atomic-Contribution path), `form-runtime/index.ts`'s
   `validateOne` (runtime validation), and the widget in `FormRuntime.tsx`.
   A type that's recognized in the first two but absent from the RM
   serialization layers is exactly the DV_IDENTIFIER/DV_PROPORTION shape
   of bug - it silently falls through to a generic passthrough that
   doesn't produce a valid RM structure.
3. **Find or import a real WebTemplate with that type actually bound** -
   check `list_remote_templates` / `get_remote_template_detail` beyond
   just the `vg_*` templates already imported (the working "Vital_Signs"
   template, not `vg`-prefixed, is what had the DV_PROPORTION fields -
   don't assume the type only shows up in already-familiar templates).
   Zero live examples of a type in this system doesn't mean low priority;
   it means the fix is currently *unverifiable* until one is found.
4. **Build a minimal real Form Section, launch it in the browser, submit
   a value, and read EHRbase's own response** - not just a passing unit
   test. Both DV_IDENTIFIER and (especially) DV_PROPORTION's wire-format
   fixes came from EHRbase's own error message correcting a wrong
   guess (`"Cannot deserialize value of type java.lang.Long from String
   \"percent\""`), not from documentation. Confirm via a direct AQL
   readback of the committed composition, not just "no 400 was thrown."
5. **Ship as its own PR** with the live evidence quoted in the
   description, regression tests added at every layer touched, and an
   honest note in the code (and this doc) if any part of the fix is
   still a best-effort guess pending a live example.

## Already done

| RM type | Gap found | Fix | PR |
|---|---|---|---|
| DV_QUANTITY | Per-unit magnitude range/precision parsed correctly but discarded before reaching a generated field; never validated even where present | `constraints.unitOptions` preferred over lossy `constraints.units`; `validateOne` warns on range/precision violation | #42 |
| DV_IDENTIFIER | No FLAT serialization branch - wrote a bare string with no `|id` suffix | `setFlatValue`/`readFlatValue` write/read `path|id` (+ optional issuer/assigner/type) | #43 |
| DV_PROPORTION | No serialization branch anywhere (FLAT or canonical); no widget (rendered as a plain number); `type`/PROPORTION_KIND unenforced | Full `{numerator, denominator?}` widget + serialization + PROPORTION_KIND validation | #44, corrected live #45 |

## Backlog - grounded in actual code, not assumption

Ordered by how confident the evidence is that a real gap exists, most
confident first.

### 1. DV_ORDINAL - fixed and live-confirmed (PR #46, #47)

**Spec** (verified 2026-09-02 against the actual [RM Data Types
IM](https://specifications.openehr.org/releases/RM/latest/data_types.html),
section 6.2.4): `value: Integer` (1..1) and `symbol: DV_CODED_TEXT`
(1..1), inheriting from `DV_ORDERED`. Quoted verbatim: *"value: Integer
- Value in ordered enumeration of values. Any integer value can be
used."* / *"symbol: DV_CODED_TEXT - Coded textual representation of
this value in the enumeration ... Codes come from archetype."* Both
attributes are mandatory (1..1) - an ordinal position *and* its display
term as a real coded text, not just one or the other.

**#46 built the missing serialization**: a `buildLeafDvValue` branch in
`canonicalComposition.ts` producing the genuine `{value, symbol}`
structure from a field's `options[].ordinal` (archetype-fixed integer,
extracted by `webTemplateParser.ts` per option, best-effort since no
real DV_ORDINAL-with-options example existed anywhere in this system at
the time), plus the matching FLAT `setFlatValue`/`readFlatValue`
branches in `openehr-engine/src/index.ts`.

**Live test (2026-09-02) surfaced a second, unrelated bug, not in the
DV_ORDINAL branch itself**: the only real DV_ORDINAL-accepting archetype
path in this system, `vg_Person.v1.1.1`'s "Versicherungsnummer"
(at0006), turned out to be a genuine RM union slot - a wrapper `ELEMENT`
node whose 5 concrete-type children (`DV_IDENTIFIER`/`DV_COUNT`/
`DV_ORDINAL`/`DV_TEXT`/`DV_CODED_TEXT`) **all share the identical
aqlPath** `.../items[at0006]/value`. `buildNode`'s wrapper-ELEMENT branch
resolved the same one bound field for every child (it keys purely by
aqlPath) and returned on whichever child came first in the WebTemplate's
own order - `DV_IDENTIFIER`, not `DV_ORDINAL`. A "Mild" pain-score
selection, bound as `DV_ORDINAL` end to end in the form's own binding,
round-tripped through a real submission and AQL readback as
`{_type: 'DV_IDENTIFIER', id: 'at0012'}`. Confirmed via direct AQL
against the live composition, not inferred from the code. This is the
same class of bug as `[[readflatvalue-coded-text-union-bug]]`, but a
different manifestation of it (concrete-typed sibling nodes, not one
ambiguous `rmType: 'ELEMENT'` node) - the existing override for that
first shape didn't cover this one.

**Fix (PR #47)**: the wrapper-ELEMENT branch now prefers whichever
child's own `rmType` matches the resolved field's declared
`semanticType` (its own binding's `rmType`), falling back to the old
first-match behaviour only when none does. Re-tested live after the
fix: a "Severe" selection now round-trips as a genuine
`{_type: 'DV_ORDINAL', value: 2, symbol: {_type: 'DV_CODED_TEXT',
value: 'Severe', defining_code: {code_string: 'at0013',
terminology_id: {value: 'local'}}}}` - exact spec shape, confirmed by
direct AQL readback.

**Caveat carried forward**: the per-option `ordinal` integer extraction
in `webTemplateParser.ts` is still best-effort by analogy to
DV_SCALE's confirmed WebTemplate shape (`inputs[].list[].scale`) - no
real DV_ORDINAL WebTemplate node with a populated `list` of options has
been found to confirm the field name is really `ordinal` rather than
something else. The hand-configured test options used for this live
test were synthetic (added directly to the form's `options[]`, not
read from the archetype's own option list), so this one caveat is
unverified still.

### 2. DV_TEXT archetype-constrained pattern - real gap, previous draft of this doc had the mechanism wrong

**Correction**: the first draft of this document called this a "length
constraint" (`C_STRING` min/max length) - checked against the actual
[AOM2 specification](https://specifications.openehr.org/releases/AM/latest/AOM2.html)
and that's **wrong**. `C_STRING` has no length attribute at all. Its
real constraint shape, quoted from the spec: *"A list of possible
string values, which may include regular expressions, which are
delimited by '/' characters"* - formally `constraint: List<String>`.
An archetype constrains a DV_TEXT node either to an enumerated set of
allowed literal strings, or to a regex pattern (delimited by `/.../`) -
never a numeric length range. (A length limit, if a modeler wants one,
would itself be expressed as a regex like `/^.{1,255}$/` - it isn't a
separate mechanism.)

**Confirmed in code**: `webTemplateParser.ts` has no DV_TEXT-specific
`inputs[]` branch at all (unlike DV_QUANTITY's dedicated range/precision
extraction) - so if an archetype does constrain a text node with a
regex pattern, this parser currently drops it entirely. This matters
because `field.validation.regex` **already exists and is already
enforced** in `form-runtime/index.ts`'s `validateOne` (`if
(field.validation?.regex && typeof value === 'string') ...`) - it's
just never auto-populated from the archetype today, only ever hand-typed
by a form designer. This is a smaller, more precise gap than the
original "length" framing: the validation mechanism already exists and
works, it just isn't fed archetype-derived constraints the way
DV_QUANTITY's now is.

**Live search (2026-09-02): no example exists anywhere in this system.**
Checked every clinically-meaningful WebTemplate on the active EHRbase
connection - all 5 already-imported `vg_*`/`Vital_Signs` templates plus
18 more fetched fresh (`vg_Procedure`, `vg_MedicationStatement`,
`vg_ServiceRequest`, `vg_MedicationAdministration`, `vg_Specimen`, all
8 oncology templates, and the German `vg_diagnostikbefund`/
`vg_pflegebericht`/`vg_entlassungsbrief` set) - 23 of the 28 templates
on the connection, skipping only the obvious dev/test ones
(`vg_control_test`, `vg_empty_test`, `vg_progessnote`) and the
"composed"/"packed" wrapper templates that just re-bundle pieces
already checked. Every single `DV_TEXT` node across all 23 has a plain
`inputs: [{"type": "TEXT"}]` - zero `list` entries, zero `pattern` keys,
nowhere. This is the same shape of finding as the pre-#46 DV_ORDINAL
search (no live example), but here after checking essentially the
entire template catalog rather than one field. Plain, unconstrained
`DV_TEXT` itself needs no fix - `buildLeafDvValue`'s `DV_TEXT` branch
(`canonicalComposition.ts`) already produces a correct
`{_type: 'DV_TEXT', value: String(value)}` for every one of these
fields today.

**Decision: do not build this speculatively.** Unlike DV_ORDINAL (where
a wrong per-option `ordinal` guess only affects one synthetic test
value with no user-facing consequence until corrected), a wrong guess
at the archetype's `list: [...]` regex-delimiter shape here would feed
directly into `field.validation.regex`, which `validateOne` already
enforces as a **hard error** - a mis-parsed pattern could silently
start hard-blocking real existing data on next edit, with no live
example available to catch the mistake the way EHRbase's own error
message caught DV_PROPORTION's wire-format guess. This item stays
backlog until a real archetype-constrained text node turns up (e.g. a
new imported template), not attempted blind.

### 3. DV_DURATION - fixed (PR #48)

**Spec** (verified against the RM Data Types IM PDF, section 6.3's
DV_DURATION class): `value: String` - *"ISO8601 duration"*, inheriting
`DV_AMOUNT` and `ISO8601_DURATION`. Confirmed: *"a deviation from
ISO8601 is supported, allowing the 'W' designator to be mixed with
other designators"* - the regex below allows for that deviation, not
just a strict-ISO8601 pattern copied from elsewhere.

**Confirmed in code**: `canonicalComposition.ts` has a plain
passthrough (`{_type: 'DV_DURATION', value: String(value)}`) - this is
actually **structurally correct** (DV_DURATION.value is just a bare
string, no substructure needing suffixed FLAT keys the way
Quantity/Proportion/Identifier do), so this was never the same class of
bug as the others. The real gap was that **nothing validated the
string is actually a well-formed ISO 8601 duration** before it was
written - `input-duration` had no dedicated branch in `validateOne` at
all (falls through to the generic text-ish checks, none of which check
duration shape). A clinician typing "3 days" or "72h" reached EHRbase
unvalidated. Confirmed the widget itself is a plain text input
(`FormRuntime.tsx`'s `inputType()` has no `input-duration` case, so it
hits the `'text'` default) - free-text entry, no shape enforcement
anywhere client-side.

**Fix**: a `DV_DURATION_PATTERN` regex in `form-runtime/index.ts`,
built directly from the RM's own designator set (`Y`/`M`/`W`/`D` date
designators, `T` + `H`/`M`/`S` time designators, `W` explicitly allowed
alongside the others per the spec's own deviation note) with lookaheads
rejecting the two vacuous cases ISO 8601 disallows - bare `P` and `PT`
with no designators at all. A new `validateOne` branch for
`input-duration` fields, as a **hard error** (not a warning like
DV_QUANTITY's range/precision) - unlike an archetype-specific range,
the ISO 8601 duration shape is the RM type's own universal wire
contract, so a non-match is never legitimate pre-existing data, only a
genuine wire-format defect. No sign character (`-P...`) is accepted -
the RM Data Types IM text for DV_DURATION never mentions a signed form,
so that wasn't asserted without a spec citation.

No live template hunt was needed - the fix doesn't depend on
archetype-specific data, only the RM type's own inherent format
contract. 13 new tests in
`packages/core/tests/duration-format-validation.test.js` cover every
designator combination, the W-mixing deviation specifically, both
vacuous-string rejections, and the required/empty interaction.

**Live-tested anyway** (`vg_Procedure.v1.1.0`'s "Total duration",
at0061 - a real DV_DURATION-bound field): `"3 days"` was correctly
rejected client- and server-side with the exact new `duration-format`
message; the RM's own W-mixing deviation was submitted deliberately
(`P1Y2W3D`) and accepted end-to-end. AQL readback showed EHRbase stores
it as `{_type: 'DV_DURATION', value: 'P1Y17D'}` - it normalizes the
value (2 weeks + 3 days = 17 days) into a W-free canonical form on its
own side, rather than preserving the submitted designators verbatim.
That's EHRbase's own storage behavior, not a defect in this app's
validation - the deviation is real and openEHR-conformant input is
correctly accepted either way.

### 4. DV_DATE / DV_TIME / DV_DATE_TIME archetype constraints - confirmed code gap, no live example anywhere (checked)

**Spec** (verified via the actual [AOM2 specification](https://specifications.openehr.org/releases/AM/latest/AOM2.html) -
this item was "not yet checked, plausible" in the first draft; now
checked): openEHR ADL2 gives an archetype **two separate** ways to
constrain a date/time node, and a real fix needs to consider both, not
just one:
1. **Range constraints** - `C_DATE.constraint: List<Interval<Iso8601_date>>`
   (and the equivalent `C_TIME`/`C_DATE_TIME` forms), e.g. an ADL2 range
   like `|2004-05-20..2005-05-19|` or an open-ended one like
   `|<2005-05-19T23:59:59|`. Directly analogous to DV_QUANTITY's
   `inputs[].validation.range`.
2. **Partial-date/time patterns** - a *separate* mechanism, ISO 8601
   extended-syntax patterns like `hh:??:XX`, meaning *"any time
   consisting of hours, optional minutes, and no seconds"* - this
   constrains **precision/completeness** (does the archetype demand a
   full timestamp, or is year-only/date-only acceptable), not a value
   range. A range-only fix would miss this entirely.

**Confirmed in code** (grepped this pass, not left as an assumption):
`webTemplateParser.ts` only ever maps `DV_DATE`/`DV_TIME`/`DV_DATE_TIME`
to a widget type (`date`/`time`/`date-time`) - zero `inputs[]`
extraction for either mechanism above. `canonicalComposition.ts`'s
`buildLeafDvValue` writes a plain `{_type: 'DV_DATE', value:
String(value)}` passthrough - structurally correct (no substructure
needed, same as DV_DURATION), but nothing upstream ever populates a
range or precision constraint to check the value against, and
`validateOne` has no date/time-specific branch at all.

**Live search (2026-09-02): no example exists anywhere in this system,
same as DV_TEXT.** Checked the same 23 of 28 templates as the DV_TEXT
search (all already-imported `vg_*`/`Vital_Signs`, all 8 oncology
templates, the German `vg_diagnostikbefund`/`vg_pflegebericht`/
`vg_entlassungsbrief` set). Every single `DV_DATE`/`DV_TIME`/
`DV_DATE_TIME` node's `inputs[]` across all 23 is the bare
`[{"type": "DATETIME"}]` (or `DATE`/`TIME`) - zero `validation`/range
keys, zero pattern/precision hints, nowhere. Confirmed by direct
inspection, not just a keyword grep coming up empty.

**Decision: do not build this speculatively - same reasoning as
DV_TEXT.** Unlike DV_DURATION (whose ISO 8601 shape is the RM type's
own universal, archetype-independent contract), a date/time range or
partial-pattern constraint is genuinely archetype-specific data with
**two distinct, unconfirmed WebTemplate JSON shapes** to get right
(range vs. precision/completeness) - guessing either risks the same
DV_PROPORTION-style wrong-guess, except here there is no live
submission to correct it against (no archetype in this system exercises
either mechanism to test with), and any validation built from a wrong
guess is a **hard error** with real false-positive risk against
existing dates. This item stays backlog until a real
archetype-constrained date/time node turns up - e.g. a birth-date range
or an ICU timestamp-precision constraint in a newly imported template -
not attempted blind.

With this, both remaining "unconfirmed" backlog items (#2 DV_TEXT, #4
DV_DATE/TIME) have now been checked against the same live template
catalog and found to have zero real examples - this audit pass is
complete for what's safely buildable today. DV_QUANTITY, DV_IDENTIFIER,
DV_PROPORTION, DV_ORDINAL, and DV_DURATION are shipped and
live-verified (#42-#48); DV_TEXT and DV_DATE/TIME stay documented,
grounded gaps rather than either guessed-at code or silently-dropped
findings.

## Deliberately out of scope for this backlog

- **Cardinality/occurrences beyond containers** - already reasonably
  mature (`repeatMin`/`repeatMax` handling, parentRepeatable detection)
  from earlier work this project; not part of this RM-*type* audit.
- **DV_MULTIMEDIA / DV_PARSABLE / DV_URI** - no evidence any form in
  this system binds these; revisit only if a real need arises, per the
  same "don't build speculative support" stance DV_PROPORTION started
  from (it turned out to have a real need once "Vital_Signs" was found).
- **The `audit_form_bindings` MCP tool's own currency** - noted
  separately: the MCP server process backing tool calls in a Claude
  session can run a stale build if it isn't restarted after a
  `packages/mcp-server` change; not a code gap, an environment note.

## Sequencing (done)

DV_ORDINAL went first - it was the only item with a *confirmed* code
gap (zero RM handling anywhere) rather than a suspected one, and a real
(if imperfect) WebTemplate example turned up quickly
(`vg_Person.v1.1.1`'s "Versicherungsnummer"). DV_DURATION followed -
its fix doesn't depend on finding a specific archetype at all, only the
RM type's own universal format contract. DV_TEXT's `C_STRING` pattern
and DV_DATE/TIME's range-and-partial-pattern constraints were both
checked next, exhaustively (23 of 28 templates on the connection,
direct inspection of every `DV_TEXT`/`DV_DATE`/`DV_TIME`/`DV_DATE_TIME`
node's `inputs[]`) - both came back with zero real examples, so neither
was built. That was the right call, not a shortfall: guessing either
wire format risked a repeat of DV_PROPORTION's first-pass mistake (it
took a live 400 from EHRbase to catch a wrong guess there), except
here there is no live submission available to catch a wrong guess
against, and both would ship as hard validation errors with real
false-positive risk. Nothing left in this backlog is safely buildable
without a new real-world template surfacing first.
