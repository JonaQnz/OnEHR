# Simulation workspace

How the `case-simulator`, `openehr-architect`, and `clinician` agents (see
`.claude/agents/`) hand work to each other and to whoever's driving them
(a person, or the main Claude Code session acting as "IT").

```
case-simulator  --writes-->  docs/simulation/cases/<case-id>.md
clinician       --reads-->   a case brief
                --writes-->  docs/simulation/issues/<case-id>-<n>.md   (only when something's broken/missing)
openehr-architect --reads--> an issue that names a missing/wrong template or form
                   --acts--> imports/builds/publishes what's needed via the formbuilder MCP tools
```

- **Case briefs** (`cases/`): one file per simulated patient case. Plain
  clinical narrative - presenting complaint, history, vitals, expected
  course - not tied to any specific form/template. The clinician decides how
  to actually record it in the running system.
- **Issues** (`issues/`): one file per problem the clinician hit while trying
  to act out a case - a missing template, a form that won't validate, a tool
  that errored, a field that doesn't exist. Structured as: what I was trying
  to do, what happened, what I expected. Not a fix, not a workaround - just
  the report, same as a doctor calling IT.
- Nothing in here is picked up automatically. A person (or the main session,
  reading `issues/`) decides what to act on and by whom.

## Issue categories

Every issue file opens with a `Category:` line - one of three, chosen by
what kind of gap it actually is, not by how annoying it was to hit:

- **`bug`** - something that's supposed to work doesn't. The form/session/
  composition was built correctly and the platform still did the wrong
  thing (validated against the wrong value, dropped data, crashed, silently
  no-opped). Fix it where it lives; no design decision required.
- **`feature`** - nothing's broken, something's just not there yet: a
  clinical concept has no openEHR template, a workflow the case needs has
  no tool/route to support it. A gap, not a defect.
- **`plugin`** - the case needs a new *kind* of field or display that isn't
  in the builder's palette at all (a specialized input widget, a
  specialized clinical display, anything beyond the existing input-text/
  input-select/input-date/input-quantity set). **Default to this category
  whenever the gap is "this needs a new kind of field"** - the fix is a new
  plugin contribution (`plugin-api`'s `CustomElement`/widget extension
  points - see `packages/*-plugin` for examples), not a one-off addition to
  core Forms. Bolting every clinical team's specialized input onto the core
  builder doesn't scale; the plugin boundary exists precisely so it doesn't
  have to.

Routing by category: `bug` and `feature` issues about templates/forms go to
`openehr-architect`; `bug` issues about the platform itself and `plugin`
issues (new code, not template/design work) go to whoever's acting as IT -
`openehr-architect` isn't equipped to author a plugin package, only to flag
that one's needed.
