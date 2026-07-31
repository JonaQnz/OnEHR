# Current Architecture State

## Monorepo Structure
The repository is an npm workspace monorepo consisting of:
- **`apps/`**: Contains the `api` (Node.js/Express) and `web` (React/Vite).
- **`packages/`**: Contains `core`, `plugin-api`, and various plugins (`aql-prefill-plugin`, `example-n8n-plugin`, `example-vitals-plugin`, `formbuilder-plugin-clinical-scores`, `formbuilder-plugin-iframe`, `react-form-builder2`).

## Dependencies
- **`apps/api`** directly depends on `core`, `plugin-api`, `formbuilder-plugin-aql-prefill`, `formbuilder-plugin-iframe`, and `prisma`.
- **`apps/web`** directly depends on `core`, `react-form-builder2`, `formbuilder-plugin-aql-prefill`, `formbuilder-plugin-clinical-scores`.
- Plugins generally rely on `core` and `plugin-api`.

## Technical Debt & Issues Identified
1. **Type Safety (High Impact):**
   - Widespread use of `any` across the codebase (>400 instances).
   - Prominent in `react-form-builder2` typings, plugin implementations (`clinical-scores`, `n8n`), and some parts of `core/src/canonical` and `core/src/form-runtime`.
   - Missing Runtime schemas at boundaries.

2. **Frontend/Backend Duplication:**
   - Both the frontend (`web/src/adapters/formBuilderAdapter.ts`) and backend (`api/src/parsers/webTemplateParser.ts`) seem to have logic mapping to form definitions.

3. **Core Dependencies:**
   - The `api` and `web` packages have hardcoded dependencies on specific plugins instead of discovering them dynamically. 
   - EHRbase connectivity is directly implemented in the backend via `ehrbaseDataProvider.ts` and `ehrbaseService.ts`.

4. **Tests:**
   - Minimal test coverage detected so far; only `api` seems to have a `test` script defined in the root `package.json`.

5. **Error Handling:**
   - Errors are often treated as strings or `any`. No canonical, structured error object found mapping to form fields or openEHR paths.

6. **Runtime State:**
   - Implicit runtime states in `formSessionService.ts` and frontend React context, rather than a strict state machine.

7. **Public APIs:**
   - There's a `plugin-api` package, but the boundary is blurry since `apps` directly import specific plugins.

8. **Composition Mapping:**
   - Currently fragmented between API logic and Core logic.
