# openEHR Clinical Form Builder

An openEHR-first **Clinical Form Builder** designed to separate clinical semantics (openEHR), visual form presentation (drag-and-drop form builder), and EHRbase interoperability.

This project enables clinical domain experts and developers to import openEHR WebTemplates, visually customize clinical forms with drag-and-drop controls, edit openEHR bindings, and export definitions to target formats such as **CambioForm v1.1**. With its robust plugin system and Live Form engine, it also acts as a full-fledged runtime for clinical data capture.

---

## 🚀 Features

- **openEHR WebTemplate Integration**: Upload and parse openEHR WebTemplate JSON files into structured field registries.
- **Auto-Generated Canonical Form Models**: Automatically initialize structured canonical forms from openEHR templates with sensible default layouts.
- **Visual Drag-and-Drop Form Builder**: Interactive React canvas with support for multi-column layouts, nested fieldsets, input validations, and custom clinical form elements.
- **Live Form Engine (Session Management)**: Run forms in "Live" mode tied to patient IDs, complete with autosave (drafts) and automated EHRbase submission.
- **openEHR Mapping Inspector**: View, edit, and assign openEHR metadata attributes directly per form field.
- **Extensible Plugin System (`plugin-api`)**: An expansive plugin SDK enabling developers to extend backend APIs, inject frontend React components, provide custom workflow hooks, or handle form submissions securely.
- **CambioForm v1.1 Export**: Export form structures and mapping definitions into standard `CambioForm.v1.1` JSON format.
- **Configurable EHRbase & Keycloak Integration**: Dynamic endpoint management for openEHR EHRbase REST APIs and Keycloak authentication.

---

## 🔌 Plugins Ecosystem

Plugins are ordinary TypeScript/JavaScript npm packages using the shared `plugin-api` contract. The server securely executes trusted backend code while dynamically serving frontend React extensions.

### Core Plugins included:

- **`formbuilder-plugin-aql-prefill`**: Allows querying EHRbase via AQL to automatically prefill form data. Configurable on a form, group, or field level directly via the form designer.
- **`formbuilder-example-n8n-plugin`**: Demonstrates integration with [n8n](https://n8n.io/) to trigger external orchestration workflows upon form events (e.g. `afterSubmit`).
- **`formbuilder-example-vitals-plugin`**: A reference plugin adding custom clinical widgets and lifecycle hooks.

To enable plugins, install them in the repository and list them in your environment variables:
```bash
FORM_BUILDER_PLUGINS=formbuilder-plugin-aql-prefill,formbuilder-example-vitals-plugin,formbuilder-example-n8n-plugin
```

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
