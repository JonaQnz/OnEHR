# onEHR: An openEHR Clinical Form Platform

<p align="center">
  <img src="docs/assets/onehr-logo.png" alt="OnEHR" width="420" />
</p>

onEHR is an openEHR-first Clinical Form Platform for building, running, and embedding interoperable clinical applications — with authentication, role-based access control, multi-connection EHRbase support, and AI-agent-native tooling built in.

It combines a visual drag-and-drop designer, a powerful runtime engine, a typed plugin ecosystem, native openEHR interoperability, and two purpose-built MCP servers so an AI agent can design, wire up, and operate clinical forms directly against a real EHRbase instance.

Import WebTemplates, design modern clinical forms, define mappings and business logic, execute forms anywhere, and seamlessly integrate with EHRbase or your own infrastructure.

Built around clean architecture, portability, and extensibility, onEHR separates clinical semantics from presentation, enabling reusable forms that remain independent of any specific EHR system.

---

## Disclaimer

onEHR was developed with extensive AI assistance.

The vision, architecture, product decisions, and technical direction come from a programmer with with over 10 years of professional experience building healthcare software (me). AI was used as a development tool, not as a substitute for software engineering. I wanted to create this project, because i saw a huge gap. But I had no time at hand to do it by hand. I hope this Project will be used and extended by many capable people who believe in the vision but want something, that was validated and extended by human hand.

So: Judge this project by its architecture, code quality, documentation, and usefulness.. not by how the code was written. This project would not exist without Codex and Antigravity. Decide for yourself if this is wrong.

---

## Terminology: Form Section vs. Form

onEHR draws a hard line between two kinds of definitions:

- **Form Section** — a reusable clinical building block (e.g. "Diagnosis", "Vital Signs", "Kleines Blutbild"). Bound to an openEHR archetype/template, but not launchable on its own.
- **Form** (a Composition) — a patient-launchable assembly of one or more Form Sections into pages, plus widgets and shared/general data. This is what gets started, filled in, and submitted for a real patient.

Designing at the Form Section level keeps clinical building blocks small, testable, and reusable across many Forms, while every patient-facing launch always goes through a proper Form wrapper.

---

## Features

### Design

- **Visual Form Designer** — Build clinical forms using an intuitive drag-and-drop editor with flexible layouts, reusable components, and configurable validation.
- **openEHR WebTemplate Integration** — Import openEHR WebTemplates and automatically generate structured, editable form models while preserving clinical semantics.
- **Mapping Inspector** — Inspect and customize openEHR paths, RM types, metadata, and field mappings directly within the designer.
- **Portable Form Definitions** — Create reusable, versioned form packages that can be shared, embedded, and deployed across different applications.
- **Repeatable Groups** — Model fixed or variable-length repeating structures (e.g. a lab panel's analyte rows) with `repeatMin`/`repeatMax` and script-driven pre-fill.

### Runtime

- **Embedded Form Engine** — Run forms directly inside your own applications with support for create, edit, view, and draft workflows.
- **Live Data Capture** — Load existing patient data, manage drafts with autosave (configurable debounce, per-form or global default), and submit Compositions to openEHR repositories such as EHRbase.
- **Form Scripting Engine** — Implement calculations, conditional logic, validation rules, API calls, and lifecycle events using TypeScript.
- **Composition Lifecycle & Versioning** — Full version history, audit trail, and semantic diffing for every Composition, with a clinical-editing lifecycle (draft validation, navigation guards) and grouped Contribution saves across multi-block Compositions.
- **Session Reuse & Storage Strategy** — Configure per-form (or system-wide default) whether a new session is created per visit or an existing draft/composition is reused.

### Security & Access Control

- **Application Authentication** — Forms owns its own authentication and opaque server-side session, independent of any EHRbase/HIP connection. Supports local username/password accounts (Argon2id-hashed) or `hip` mode, which authenticates through the active HIP/Keycloak system-connection plugin and creates a local shadow user — the upstream token never reaches the browser.
- **Role-Based Access Control** — Granular, permission-based authorization (`ApplicationUser`, `RoleAssignment`) rather than a fixed admin/user split.
- **Audit Logging** — Authentication events, user administration, and role changes are recorded as structured audit events (`AuditEvent`).
- **Session Security** — `HttpOnly`, `SameSite=Lax` cookies, configurable session lifetime, and full session revocation on deactivation or password reset.

### Integration & Data

- **Multi-Connection EHRbase Support** — Configure and switch between multiple EHRbase (or HIP) connections, each with its own pluggable authentication method.
- **AQL & Code Functions** — Define reusable, versioned AQL queries or sandboxed JavaScript functions (`AqlFunction`, `CodeFunction`) that forms can call at runtime for prefill, validation, or derived values — backed by EHRbase's own stored-query service.
- **Clinical Data Widgets** — Build read-only "show me patient data" cards (`DataWidget`) driven by AQL functions, independent of any single form.
- **EHRbase-Native Drafts** — Drafts persist as real EHRbase versions, not just rows in the local database.
- **Patient Discovery** — Discover every EHR in a connected EHRbase instance as a patient, flagging native vs. imported records.

### Platform

- **Plugin SDK** — Extend the platform with custom fields, functions, integrations, workflow hooks, backend services, and frontend components.
- **AI-Agent-Native Tooling** — Two purpose-built MCP servers let an AI agent design forms, manage templates, and operate the running system directly (see below).
- **Developer-Focused Architecture** — Modular packages, strong TypeScript typing, clean APIs, and a clear separation between clinical models, runtime, and presentation.
- **CambioForm v1.1 Export** — Export form structures and mapping definitions in the standard `CambioForm.v1.1` format.

---

## 🤖 AI-Agent-Native Tooling (MCP Servers)

onEHR ships two [Model Context Protocol](https://modelcontextprotocol.io/) servers, so an AI coding agent can act as a real collaborator on both the Forms application and the underlying openEHR templates — not just generate code for them.

### `formbuilder-mcp-server`

Exposes onEHR's own Form Builder, Composition Builder, patient, and form-runtime APIs as MCP tools: creating and publishing Form Sections and Forms, managing drafts and versions, launching forms for a patient, creating and querying data widgets, managing AQL/code functions, and driving live form sessions end-to-end (`create_form`, `update_form`, `publish_form`, `launch_form`, `create_patient`, `create_data_widget`, `run_aql_query`, `submit_form_session_to_provider`, and more).

### `openehr-architect-mcp`

Talks directly to EHRbase's own openEHR Definitions REST API — not through the Forms app — so an agent can inspect and author openEHR Operational Templates: list templates, fetch them as WebTemplate JSON or raw OPT XML, upload new ones, and compose document templates. No self-hostable, API-driven template-design tool exists in the ecosystem today, so this server is a thin, direct bridge to EHRbase's own definitions endpoint.

Both servers are registered in `.mcp.json` at the repo root, so any MCP-compatible agent (including Claude Code) gets full tool access out of the box.

---

## 🔌 Plugin Ecosystem

Plugins are ordinary TypeScript/JavaScript npm packages using the shared `plugin-api` contract. The server securely executes trusted backend code while dynamically serving frontend React extensions.

### Included plugins

- **`formbuilder-plugin-aql-prefill`** — Query EHRbase via AQL to automatically prefill form data, configurable on a form, group, or field level directly via the designer.
- **`formbuilder-plugin-iframe`** — A frontend custom field plugin that embeds an iframe anywhere in a form; demonstrates custom layout fields and runtime renderers.
- **`formbuilder-plugin-clinical-scores`** — Ships reusable clinical calculation functions (e.g. BMI, NEWS2) usable from any form's scripting engine.
- **`formbuilder-plugin-postal-lookup`** — Looks up city/state from a German/Austrian/Swiss/Liechtenstein postal code via the open-source OpenPLZ API.
- **`formbuilder-example-n8n-plugin`** — Demonstrates integration with [n8n](https://n8n.io/) to trigger external orchestration workflows on form events (e.g. `afterSubmit`).
- **`formbuilder-example-vitals-plugin`** — Small example plugin for testing the plugin system itself.

### Extending the SDK (Frontend Custom Fields)

The SDK supports powerful UI injections:
- **`registerField`** — Inject entirely new drag-and-drop components into the Form Builder's *Layout Elements* toolbox.
- **`registerRenderer`** — Provide native React implementations for those custom fields when executed inside `FormRuntime` (Live Mode / Preview).

To enable plugins, install them in the repository and list them in your environment variables or local `data/config.json`:
```json
"pluginPackages": [
  "formbuilder-plugin-aql-prefill",
  "formbuilder-plugin-iframe",
  "formbuilder-plugin-clinical-scores",
  "formbuilder-plugin-postal-lookup",
  "formbuilder-example-n8n-plugin"
]
```

---

## 🧠 Form Scripting Engine

The built-in Scripting Engine allows you to attach dynamic behavior directly to forms without writing external plugins.

- **Lifecycle Hooks** — Write code that triggers on events like `beforeLoad`, `afterLoad`, `onValidation`, `beforeSubmit`, and `afterSubmit`.
- **UI State Management** — Dynamically change field properties via `uiStates` (e.g., hiding a field if a specific checkbox is ticked, or disabling input).
- **Validation** — Enforce complex, cross-field validation rules that block submission until resolved.
- **Repeatable Group Operations** — Read, replace, add, and remove items in repeatable groups (`form.group(...).replaceItems([...])`), typically used to pre-fill fixed-structure panels.
- **Context Injection** — Access form metadata, `patientId`, `ehrId`, integration function results, and other session parameters directly within your scripts.

---

## 🏗️ Architecture & Technology Stack

The project is structured as an **npm workspaces monorepo**:

```text
onehr/
├── docker-compose.yml           # Multi-container setup (PostgreSQL, API, Web)
├── .mcp.json                    # MCP server registration (formbuilder + openehr-architect)
├── package.json                 # Workspace root configuration
├── apps/
│   ├── api/                     # Express.js + TypeScript + Prisma ORM backend
│   └── web/                     # React + Vite + TypeScript frontend
├── packages/
│   ├── core/                            # Shared TypeScript interfaces & canonical models
│   ├── openehr-engine/                  # Pure openEHR mapping & form-definition helpers
│   ├── plugin-api/                      # Plugin SDK definitions & runtime interfaces
│   ├── react-form-builder2/             # Drag-and-drop UI component library for form editing
│   ├── mcp-server/                      # formbuilder-mcp-server (Forms app as MCP tools)
│   ├── openehr-architect-mcp/           # Direct EHRbase Definitions API as MCP tools
│   ├── aql-prefill-plugin/              # AQL Prefill plugin implementation
│   ├── formbuilder-plugin-iframe/       # Custom iframe field implementation
│   ├── formbuilder-plugin-clinical-scores/ # Clinical calculation functions (BMI, NEWS2, ...)
│   ├── postal-lookup-plugin/            # Postal code lookup plugin
│   ├── example-n8n-plugin/              # Example n8n workflow integration plugin
│   └── example-vitals-plugin/           # Example vitals plugin
└── data/                        # Local configuration and exports (git-ignored secrets)
```

### Core Technologies
- **Frontend (`apps/web`)**: React 18, Vite, TypeScript, React Router, Recharts, customized `react-form-builder2` library.
- **Backend (`apps/api`)**: Node.js, Express.js, TypeScript, Prisma ORM, Argon2id password hashing, `jose` (JWT/JWK), Axios.
- **Database**: PostgreSQL (with JSONB support for canonical form definitions, live sessions, and audit events).
- **AI Tooling**: Two MCP servers built on `@modelcontextprotocol/sdk` and `zod`.
- **Containerization**: Docker & Docker Compose.

---

## 🛠️ Getting Started

### Prerequisites

Ensure you have the following installed on your machine:
- **Node.js**: `v18.x` or higher
- **npm**: `v9.x` or higher
- **Docker & Docker Compose** (highly recommended for the EHRbase backend stack)

---

### Method 1: Running with Docker Compose (Recommended)

1. Clone the repository:
   ```bash
   git clone https://github.com/JonaQnz/OnEHR.git
   cd OnEHR
   ```

2. Start all services (Database, API, Web):
   ```bash
   docker-compose up --build
   ```

3. Access the applications:
   - **Frontend App**: [http://localhost:3000](http://localhost:3000)
   - **API Server**: [http://localhost:3001/api/health](http://localhost:3001/api/health)
   - **PostgreSQL Database**: `localhost:5432`

---

### Method 2: Local Development Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Build Shared Packages**:
   ```bash
   npm run build:packages
   ```

3. **Database Setup**:
   Ensure PostgreSQL is running locally, then configure environment variables:
   ```bash
   cp apps/api/.env.example apps/api/.env
   # Update DATABASE_URL in apps/api/.env if needed
   ```

   Run Prisma migrations:
   ```bash
   cd apps/api
   npx prisma migrate dev
   npx prisma db push
   cd ../..
   ```

4. **Bootstrap the first administrator** (local auth mode):
   ```bash
   FORMS_BOOTSTRAP_ADMIN_USERNAME=admin-name
   FORMS_BOOTSTRAP_ADMIN_PASSWORD=a-long-unique-password-of-at-least-12-characters
   FORMS_BOOTSTRAP_ADMIN_DISPLAY_NAME=Forms Administrator
   ```
   See the [Wiki: Authentication & Access Control](../../wiki/Authentication-and-Access-Control) for HIP/Keycloak mode and role management.

5. **Start Development Servers**:
   - **Backend API**:
     ```bash
     cd apps/api
     npm run dev
     ```
   - **Frontend Web**:
     ```bash
     cd apps/web
     npm run dev
     ```

---

## 📊 Database Schema

The system uses PostgreSQL with Prisma ORM. Key tables, grouped by area:

**Forms & Templates**
- `Form` — canonical Form Section / Form models (`id`, `name`, `version`, `status`, `canonical_json`).
- `Template` — imported and parsed openEHR WebTemplates.

**Sessions & Clinical Data**
- `CompositionSession` / `FormSession` — live Form/Form Section instances tied to a patient, with autosave state.
- `CompositionVersionEvent` — version history, audit trail, and semantic diff entries per Composition.
- `ClinicalTransaction` / `ClinicalTransactionOperation` — grouped Contribution saves spanning multiple Composition blocks.
- `Patient` — discovered or imported patient/EHR records.

**Integration & Widgets**
- `AqlFunction` / `CodeFunction` — reusable, versioned AQL queries and sandboxed JS functions.
- `DataWidget` — read-only clinical data cards driven by AQL functions.

**Auth & Audit**
- `ApplicationUser` / `RoleAssignment` / `IdentityLink` — accounts, permissions, and linked external identities (e.g. HIP/Keycloak).
- `ApplicationSession` — opaque server-side sessions.
- `AuditEvent` — structured audit log for auth and administrative actions.

---

## 🔌 Core API Endpoints

A representative slice — see the [Wiki](../../wiki) for the full route reference.

### Forms (`/api/forms`)
- `GET /api/forms` / `GET /api/forms/:id` — list / fetch canonical forms.
- `POST /api/forms/generate` — generate a new canonical form model from a WebTemplate registry.
- `GET /api/forms/:id/export/cambio` — export to `CambioForm.v1.1` format.

### Live Sessions (`/api/form-sessions`, `/api/composition-sessions`)
- `POST /api/form-sessions` — start a new Form Section session for a patient.
- `PATCH /api/form-sessions/:id` — autosave form values (draft mode).
- `POST /api/form-sessions/:id/provider/submit` — submit a composition to a provider (e.g. EHRbase).
- `POST /api/composition-sessions/:id/blocks` — attach a Form Section block to a running Composition.

### WebTemplates (`/api/templates`)
- `GET /api/templates` / `POST /api/templates/import` — list / upload & parse WebTemplates.

### Integration Functions (`/api/aql-functions`, `/api/code-functions`, `/api/data-widgets`)
- CRUD + `run`/`query` endpoints for AQL functions, sandboxed code functions, and the clinical data widgets built on top of them.

### Auth & Users (`/api/auth`, `/api/users`)
- Login/logout/session endpoints, user administration, role assignment, and audit event retrieval.

### Plugins (`/api/plugins`)
- `GET /api/plugins` — retrieve loaded plugin manifests and UI contributions.
- `POST /api/plugins/actions/:pluginId/:actionId` — proxy execution requests to secure plugin backend handlers.

---

## 📚 Documentation

Deeper, topic-specific documentation lives in the [GitHub Wiki](../../wiki), covering architecture, authentication & RBAC, multi-connection EHRbase, the Form Scripting Engine, integration functions, the plugin SDK, and the MCP servers in detail.

---

## 📜 License

This project is licensed under the MIT License.
