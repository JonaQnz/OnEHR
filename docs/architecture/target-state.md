# Target Architecture State

The target architecture defines WatEHR as the standard openEHR form builder—a robust, testable, and highly embeddable web application, rather than a full monolithic hospital information system.

## 1. Monorepo Organization
- Maintain the NPM workspace structure, but enforce strict boundaries.
- **Core Domain:** Contains pure, technology-agnostic models (`FormDefinition`, `FormField`, `FormLayout`, `OpenEhrBinding`, etc.). It must not depend on React, Express, Prisma, or EHRbase.
- **openEHR Engine:** Handles WebTemplate parsing, RM data types, Composition building/parsing, and validation.
- **Embedded Runtime:** Manages Form states, values, validation, plugin hooks, and host communication without user management logic.
- **Designer:** Visual UI for mappings, validation configs, previewing runtime states, etc.
- **Embed SDK:** Safe `iframe` embedding via `postMessage`, explicit `WatEhrMessage<T>` protocol, and error formatting.
- **Plugin SDK:** Clear extension points (`registerField()`, `registerFunction()`, etc.) verified by Contract Tests.

## 2. API & Type Safety Rules
- **One Source of Truth:** Unify backend and frontend field types; eliminate duplicated interfaces.
- **Strict Typing:** No `any`. Exhaustive switch statements, runtime schema validation at boundaries (Zod/Runtypes), and strict TS compilation.
- **No Implicit Behavior:** Magic mappings or hardcoded template logic must be removed. Use clear declarative `rules.json` and explicit Data Sources.

## 3. Runtime & Composition State
- **Single Context Model:** Use exactly one context model (`FormContext`) defining mode (`create`, `edit`, `view`, `prefill`), IDs (ehr, patient, encounter), and environment parameters.
- **Runtime State Machine:** Transitions between explicit states (`initializing`, `ready`, `dirty`, `validating`, `submitting`, `error`).
- **Composition Roundtrip:** Guaranteed flow: `WebTemplate → FormDefinition → Form Values → Composition → Form Values`.

## 4. Logical Sandbox & Extensions
- **Declarative Rules:** Simple UI manipulations are in JSON without executable JS.
- **Form Scripts:** Limited, typed API execution without access to DOM, Node APIs, or unauthenticated HTTP.
- **Function Registry:** Pre-defined deterministic clinical functions (`math.round`, `clinical.calculateBmi`).
- **Portable Form Packages:** Everything runs on versioned packages (Manifest, Form JSON, Template JSON, Rules).

## 5. Testing
- Extensive Unit Tests.
- Integration tests for mapping.
- Contract Tests for Plugin API.
- End-to-end embedding tests.
- Golden Master tests for Composition Roundtrips.
