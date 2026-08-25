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
