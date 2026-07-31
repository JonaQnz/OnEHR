# Migration Plan

The migration to the target architecture must be done in small, executable steps without a big-bang refactoring. This plan defines the incremental approach.

## Milestone 1: Fundament (Priority 0)
1. **Repository Audit (Done):** Document current constraints and boundaries.
2. **Consolidate Common Types:** Move shared types between `apps/api/src/parsers` and `apps/web/src/adapters` into `packages/core/src/canonical`. 
3. **Increase TypeScript Strictness:** Incrementally enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` across all `package.json`/`tsconfig.json`.
4. **Remove `any`:** Gradually replace the >400 usages of `any` with precise types or `unknown` + runtime validators (e.g., Zod) in `react-form-builder2`, `plugin-api`, and `core`.
5. **Central Error Structure:** Define the `FormError` interface in `core` and begin updating try-catch blocks to emit structured errors.
6. **CI & Golden Fixtures:** Build initial `test/fixtures` directory and setup CI pipelines.

## Milestone 2: openEHR Reliability
1. **WebTemplate Parser:** Secure the WebTemplate parsing, ensuring coverage for Sections, Clusters, Elements, Cardinalities, Occurrences, and RM types.
2. **Technical Fields & Context:** Automatically extract and map attributes like `language`, `territory`, `composer` without leaking them to the UI unless explicitly configured.
3. **Composition Engine:** Separate HTTP transport (`ehrbaseDataProvider.ts`) from the Composition mapping logic so WatEHR Core does not depend on EHRbase directly.
4. **Testing:** Build the Golden Master tests asserting the roundtrip `WebTemplate → FormDefinition → Form Values → Composition → Form Values`.

## Milestone 3: Embedded Runtime
1. **Unified `FormContext`:** Introduce the `FormContext` interface enforcing strict properties and remove implicit state mechanisms.
2. **State Machine:** Implement `RuntimeStatus` transitions blocking invalid behaviors (e.g., submit during loading).
3. **Embed SDK & iframe Protocol:** Extract iframe logic into an SDK defining `WatEhrMessage<T>` with timeout handling, strict origins, and event listeners (`ready`, `changed`, `submitted`).

## Milestone 4: Logic Platform
1. **Declarative Rules:** Implement the rule evaluator avoiding arbitrary JS injection.
2. **Form Scripts API:** Build a typed sandbox (e.g., `FormScriptApi`) preventing `window`, `document`, or filesystem access.
3. **Function Registry:** Introduce `FunctionDefinition<TInput, TOutput>` enforcing typed calculation definitions, and port existing functions to this model.

## Milestone 5: Plugin SDK
1. **Plugin Manifest:** Define the `PluginManifest` schema and replace hardcoded plugin imports in `api`/`web` with dynamic manifest loading.
2. **Capabilities & Dependency Validation:** Enforce that plugins only use allowed APIs based on manifest definitions.
3. **Reference Plugins:** Clean up existing plugins, migrating them to the standardized SDK and ensuring test coverage.

## Milestone 6: Designer Quality
1. **Mapping Inspector:** Add UI for visually tracing fields (Label → RM-Typ → AQL-Pfad).
2. **Runtime Preview:** Connect the Sandbox and Rules engine so users can safely test configurations directly in the designer.

## Milestone 7: Portability & Form Packages
1. **Form Package Schema:** Standardize `form.json`, `template.json`, and `rules.json` serialization formats.
2. **Import/Export:** Implement routines to deterministically package a form and its requirements.

## Milestone 8: Open-Source Release
1. **Documentation:** Write `README.md`, Contribution guides, Security Policies.
2. **Reference Apps:** Provide end-to-end working examples (e.g., Vitals, Barthel-Assessment).
3. **First Stable API:** Freeze the public interface for the `1.0.0` release.
