# openEHR Clinical Form Builder

An openEHR-first **Clinical Form Builder** designed to separate clinical semantics (openEHR), visual form presentation (drag-and-drop form builder), and EHRbase interoperability.

This project enables clinical domain experts and developers to import openEHR WebTemplates, visually customize clinical forms with drag-and-drop controls, edit openEHR bindings, and export definitions to target formats such as **CambioForm v1.1**.

---

## 🚀 Features

- **openEHR WebTemplate Integration**: Upload and parse openEHR WebTemplate JSON files into structured field registries.
- **Auto-Generated Canonical Form Models**: Automatically initialize structured canonical forms from openEHR templates with sensible default layouts.
- **Visual Drag-and-Drop Form Builder**: Interactive React canvas with support for multi-column layouts, nested fieldsets, input validations, and custom clinical form elements.
- **openEHR Mapping Inspector**: Zuweisen and edit openEHR metadata attributes directly per form field.
- **CambioForm v1.1 Export**: Export form structures and mapping definitions into standard `CambioForm.v1.1` JSON format.
- **Configurable EHRbase & Keycloak Integration**: Dynamic endpoint management for openEHR EHRbase REST APIs and Keycloak authentication.

---

## 🏗️ Architecture & Technology Stack

The project is structured as an **npm workspaces monorepo**:

```text
formbuilder/
├── docker-compose.yml        # Multi-container setup (PostgreSQL, API, Web)
├── Dockerfile.api            # Dockerfile for Express API backend
├── Dockerfile.web            # Dockerfile for React Web frontend
├── package.json              # Workspace root configuration
├── apps/
│   ├── api/                  # Express.js + TypeScript + Prisma ORM Backend
│   └── web/                  # React + Vite + TypeScript Frontend
├── packages/
│   ├── core/                 # Shared TypeScript interfaces & Canonical models
│   └── react-form-builder2/  # Drag-and-drop UI component library for form editing
└── examples/
    ├── templates/            # Sample openEHR WebTemplates (e.g. vital_signs_icu.webtemplate.json)
    └── templates/            # Sample openEHR WebTemplates
```

### Core Technologies
- **Frontend (`apps/web`)**: React 18, Vite, TypeScript, customized `react-form-builder2` library.
- **Backend (`apps/api`)**: Node.js, Express.js, TypeScript, Prisma ORM, Axios.
- **Database**: PostgreSQL (with JSONB support for canonical form definitions).
- **Containerization**: Docker & Docker Compose.

---

## 🛠️ Getting Started

### Prerequisites

Ensure you have the following installed on your machine:
- **Node.js**: `v18.x` or higher
- **npm**: `v9.x` or higher
- **Docker & Docker Compose** (optional, for containerized runs)

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
   npm run build --workspace=core
   npm run build:lib --workspace=react-form-builder2
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

- **`forms` (`Form`)**: Stores canonical form models (`id`, `name`, `version`, `status`, `canonical_json`, timestamps).
- **`templates` (`Template`)**: Stores uploaded and parsed openEHR WebTemplates (`id`, `template_id`, `version`, `type`, `alias`, `parsed_registry_json`, timestamps).

---

## 🔌 API Endpoints Summary

### Forms (`/api/forms`)
- `GET /api/forms` - List all canonical forms.
- `GET /api/forms/:id` - Fetch a specific form by ID.
- `POST /api/forms` - Save/Update a canonical form.
- `POST /api/forms/generate` - Generate a new canonical form model from a WebTemplate registry.
- `GET /api/forms/:id/export/cambio` - Export form to CambioForm.v1.1 format.

### WebTemplates (`/api/templates`)
- `GET /api/templates` - List imported WebTemplates.
- `POST /api/templates/import` - Upload & parse a new WebTemplate JSON.

### Configuration (`/api/config`)
- `GET /api/config` - Retrieve current EHRbase & Keycloak settings.
- `POST /api/config` - Update endpoint configurations.

---

## 🔌 Plugins

Plugins are ordinary TypeScript/JavaScript npm packages using the shared `plugin-api` contract. The server executes trusted plugin code; manifests and contributions exposed to the UI remain serializable and namespaced.

Build and test the plugin-enabled app:

```bash
npm install
npm test
```

Open **Plugins** in the web app, enter `formbuilder-example-vitals-plugin`, and choose **Laden**. The page shows the host contract, the manifest, permissions, and registered contributions. The example demonstrates these extension points:
- `field`: custom field types for the designer.
- `settings`: panels in application settings.
- `form`: actions in the form designer.
- `designer`: panels in the designer workspace.
- `runtime`: actions available while filling a form.
- `dataProvider`: load/submit provider metadata (the built-in EHRbase provider remains core).
- `workflow` and `lifecycle`: server-side orchestration and validation hooks.
Plugins are trusted TypeScript/JavaScript code executed by the API process. Every package must declare its extension points and permissions (`form:read`, `form:write`, `patient:read`, `ehrbase:read`, `ehrbase:write`, or `network:request`). Packages must be installed in the self-hosted deployment; the UI does not install arbitrary code. For unattended startup, set `FORM_BUILDER_PLUGINS` to a comma-separated package list.
The n8n example is `formbuilder-example-n8n-plugin`. Configure the n8n API and target in the API environment, then load the package from the Plugins page. In each form, open `Form Settings → Submission` and click `Als n8n Form konfigurieren`:
Docker default: `N8N_API_URL=http://host.docker.internal:5678/api/v1`; lokale Ausführung: `N8N_API_URL=http://localhost:5678/api/v1`. Zusätzlich: `N8N_API_KEY=…`, `N8N_PUBLIC_URL=http://localhost:5678`, `N8N_EHRBASE_URL=http://ehrbase:8080/ehrbase/rest/openehr/v1`.
`FORM_BUILDER_PLUGINS=formbuilder-example-vitals-plugin,formbuilder-example-n8n-plugin`

## 📜 License

This project is licensed under the MIT License.
