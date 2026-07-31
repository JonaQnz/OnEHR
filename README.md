# onEHR: An openEHR Clinical Form Builder
<img width="1774" height="887" alt="image" src="https://github.com/user-attachments/assets/8aa8fd5a-46b4-4836-8328-a16cc2ba813b" />

onEHR is an openEHR-first Clinical Form Platform for building, running, and embedding interoperable clinical applications.

It combines a visual drag-and-drop designer, a powerful runtime engine, a typed plugin ecosystem, and native openEHR interoperability into a single developer platform.

Import WebTemplates, design modern clinical forms, define mappings and business logic, execute forms anywhere, and seamlessly integrate with EHRbase or your own infrastructure.

Built around clean architecture, portability, and extensibility, onEHR separates clinical semantics from presentation, enabling reusable forms that remain independent of any specific EHR system.

---


## Disclaimer

onEHR was developed with extensive AI assistance.

The vision, architecture, product decisions, and technical direction come from a programmer with with over 10 years of professional experience building healthcare software (me). AI was used as a development tool, not as a substitute for software engineering. I wanted to create this project, because i saw a huge gap. But I had no time at hand to do it by hand. I hope this Project will be used and extended by many capable people who believe in the vision but want something, that was validated and extended by human hand.  

So: Judge this project by its architecture, code quality, documentation, and usefulness.. not by how the code was written. This project would not exist without Codex and Antigravity. Decide for yourself if this is wrong.

---

## Features

### Design

- **Visual Form Designer** — Build clinical forms using an intuitive drag-and-drop editor with flexible layouts, reusable components, and configurable validation.
- **openEHR WebTemplate Integration** — Import openEHR WebTemplates and automatically generate structured, editable form models while preserving clinical semantics.
- **Mapping Inspector** — Inspect and customize openEHR paths, RM types, metadata, and field mappings directly within the designer.
- **Portable Form Definitions** — Create reusable, versioned form packages that can be shared, embedded, and deployed across different applications.

### Runtime

- **Embedded Form Engine** — Run forms directly inside your own applications with support for create, edit, view, and draft workflows.
- **Live Data Capture** — Load existing patient data, manage drafts with autosave, and submit Compositions to openEHR repositories such as EHRbase.
- **Form Scripting Engine** — Implement calculations, conditional logic, validation rules, API calls, and lifecycle events using TypeScript.

### Platform

- **Plugin SDK** — Extend the platform with custom fields, functions, integrations, workflow hooks, backend services, and frontend components.
- **EHRbase Integration** — Native support for openEHR repositories with configurable endpoints and authentication.
- **Developer-Focused Architecture** — Modular packages, strong TypeScript typing, clean APIs, and a clear separation between clinical models, runtime, and presentation.
- **CambioForm v1.1 Export** — Export form structures and mapping definitions in the standard `CambioForm.v1.1` format.

---

## 🔌 Plugins Ecosystem

Plugins are ordinary TypeScript/JavaScript npm packages using the shared `plugin-api` contract. The server securely executes trusted backend code while dynamically serving frontend React extensions.


### Core Plugins included:

- **`formbuilder-plugin-aql-prefill`**: Allows querying EHRbase via AQL to automatically prefill form data. Configurable on a form, group, or field level directly via the form designer.
- **`formbuilder-plugin-iframe`**: A frontend custom field plugin that allows form designers to embed an Iframe anywhere in the form. Demonstrates how to register custom layout fields and runtime renderers.
- **`formbuilder-example-n8n-plugin`**: Demonstrates integration with [n8n](https://n8n.io/) to trigger external orchestration workflows upon form events (e.g. `afterSubmit`).
- **`formbuilder-example-vitals-plugin`**: A reference plugin adding custom clinical widgets and lifecycle hooks.

### Extending the SDK (Frontend Custom Fields)
The SDK supports powerful UI injections:
- **`registerField`**: Allows plugins to inject entirely new drag-and-drop components into the Form Builder's *Layout Elements* toolbox.
- **`registerRenderer`**: Allows plugins to provide native React implementations for those custom fields when they are executed inside the `FormRuntime` (Live Mode / Preview).

To enable plugins, install them in the repository and list them in your environment variables or local `data/config.json`:
```json
"pluginPackages": [
  "formbuilder-plugin-aql-prefill",
  "formbuilder-plugin-iframe",
  "formbuilder-example-n8n-plugin"
]
```

---

## 🧠 Form Scripting Engine

The built-in Scripting Engine allows you to attach dynamic behavior directly to forms without writing external plugins.

- **Lifecycle Hooks**: Write code that triggers on events like `beforeLoad`, `afterLoad`, `onValidation`, `beforeSubmit`, and `afterSubmit`.
- **UI State Management**: Dynamically change field properties via `uiStates` (e.g., hiding a field if a specific checkbox is ticked, or disabling input).
- **Validation**: Enforce complex, cross-field validation rules that block submission until resolved.
- **Context Injection**: Access form metadata, `patientId`, `ehrId`, and other session parameters directly within your scripts.

---

## 🏗️ Architecture & Technology Stack

The project is structured as an **npm workspaces monorepo**:

```text
formbuilder/
├── docker-compose.yml        # Multi-container setup (PostgreSQL, API, Web)
├── package.json              # Workspace root configuration
├── apps/
│   ├── api/                  # Express.js + TypeScript + Prisma ORM Backend
│   └── web/                  # React + Vite + TypeScript Frontend
├── packages/
│   ├── core/                           # Shared TypeScript interfaces & Canonical models
│   ├── plugin-api/                     # Plugin SDK definitions & runtime interfaces
│   ├── react-form-builder2/            # Drag-and-drop UI component library for form editing
│   ├── aql-prefill-plugin/             # AQL Prefill plugin implementation
│   ├── formbuilder-plugin-iframe/      # Custom Iframe field implementation
│   ├── formbuilder-example-n8n-plugin/ # Example n8n workflow integration plugin
│   └── formbuilder-example-vitals-plugin/ # Example vitals plugin
└── data/                     # Local configurations and exports
```

### Core Technologies
- **Frontend (`apps/web`)**: React 18, Vite, TypeScript, customized `react-form-builder2` library.
- **Backend (`apps/api`)**: Node.js, Express.js, TypeScript, Prisma ORM, Axios.
- **Database**: PostgreSQL (with JSONB support for canonical form definitions & live sessions).
- **Containerization**: Docker & Docker Compose.

---

## 🛠️ Getting Started

### Prerequisites

Ensure you have the following installed on your machine:
- **Node.js**: `v18.x` or higher
- **npm**: `v9.x` or higher
- **Docker & Docker Compose** (Highly recommended for the EHRbase backend stack)

---

### Method 1: Running with Docker Compose (Recommended)

1. Clone the repository:
   ```bash
   git clone https://github.com/JonaQnz/openehr-form-builder.git
   cd openehr-form-builder
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

4. **Start Development Servers**:
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

The system uses PostgreSQL with Prisma ORM. Key tables:

- **`Form`**: Stores canonical form models (`id`, `name`, `version`, `status`, `canonical_json`, timestamps).
- **`Template`**: Stores uploaded and parsed openEHR WebTemplates (`id`, `template_id`, `version`, `type`, `alias`, `parsed_registry_json`, timestamps).
- **`FormSession`**: Stores "Live Form" instances tied to a patient with autosave states and submission results (`id`, `patientId`, `ehrId`, `status`, `values`).

---

## 🔌 Core API Endpoints

### Forms (`/api/forms`)
- `GET /api/forms` - List all canonical forms.
- `GET /api/forms/:id` - Fetch a specific form by ID.
- `POST /api/forms/generate` - Generate a new canonical form model from a WebTemplate registry.
- `GET /api/forms/:id/export/cambio` - Export form to CambioForm.v1.1 format.

### Live Form Sessions (`/api/form-sessions`)
- `POST /api/form-sessions` - Start a new form session for a patient.
- `PATCH /api/form-sessions/:id` - Autosave form values (Draft mode).
- `POST /api/form-sessions/:id/provider/submit` - Execute formal composition submission (e.g. to EHRbase).

### WebTemplates (`/api/templates`)
- `GET /api/templates` - List imported WebTemplates.
- `POST /api/templates/import` - Upload & parse a new WebTemplate JSON.

### Plugins & Extensions (`/api/plugins`)
- `GET /api/plugins` - Retrieve all loaded plugin manifests and UI contributions.
- `POST /api/plugins/actions/:pluginId/:actionId` - Proxies execution requests to secure plugin backend handlers.

---

## 📜 License

This project is licensed under the MIT License.
