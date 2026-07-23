# openEHR-first Clinical Form Builder MVP

Dieser Plan beschreibt die Architektur und Umsetzung des MVPs für den Clinical Form Builder. Er veranschaulicht die Trennung zwischen klinischer Semantik (openEHR), Darstellung (Form Builder) und Interoperabilität (FHIR), wie gefordert.

## Open Questions
1. **react-form-builder2 Herkunft**: In den Anforderungen steht "Lade ihn als erstes von Github herunter und nutze diesen." Bedeutet dies, dass der Quellcode des Form Builders direkt in das Projekt geklont und als lokales Paket/Modul eingebunden werden soll (z. B. um Anpassungen am Quellcode vornehmen zu können), oder reicht die Installation über `npm install react-form-builder2`? (Der Plan geht aktuell von einer npm-Installation aus).
2. Gibt es ein spezifisches Basis-Image für PostgreSQL (z. B. `postgres:15-alpine`), das bevorzugt wird?
3. Sollen wir für das Monorepo `npm workspaces` oder `yarn workspaces` nutzen? (Der Plan sieht `npm workspaces` vor).

## Proposed Architecture

Wir werden ein Monorepo mit **npm workspaces** aufbauen. Das Backend nutzt **Express.js (TypeScript)** und das Frontend **React (Vite, TypeScript)**. Als Datenbank setzen wir **PostgreSQL** mit **Prisma ORM** (für einfache Modellierung und Typisierung) ein.

### Projektstruktur

```text
clinical-form-builder/
├── docker-compose.yml
├── Dockerfile.api
├── Dockerfile.web
├── package.json (Workspace Root)
├── apps/
│   ├── web/               (React + Vite)
│   └── api/               (Express + Node.js)
├── packages/
│   └── core/              (Shared Interfaces)
└── examples/
    ├── templates/         (z. B. vital_signs_icu.webtemplate.json)
    └── fhir-catalog/      (lokale FHIR JSONs)
```

## Datenmodell (Datenbank)

Wir legen folgende Tabellen an (via Prisma Schema):
- **Form**: `id`, `name`, `version`, `status`, `canonical_json` (JSONB), `created_at`, `updated_at`
- **Template**: `id`, `template_id`, `version`, `type`, `alias`, `parsed_registry_json` (JSONB), `created_at`
- **FhirCatalog**: `id`, `name`, `fhir_version`, `catalog_json` (JSONB), `created_at`
- **FhirMapping**: `id`, `form_id`, `field_name`, `mapping_json` (JSONB), `created_at`, `updated_at`

*Hinweis*: Für den MVP speichern wir das komplette Canonical Model als JSONB in `Form.canonical_json`, was ein späteres Parsen und Erweitern stark vereinfacht.

## Kern-Workflows

1. **Template Import**: WebTemplate (JSON) hochladen -> API parst es in die `Field Registry`.
2. **Auto-Generierung**: Aus der `Field Registry` erzeugt die API ein initiales `Canonical Form Model` mit grundlegendem Layout.
3. **Editor**: Das Frontend lädt das Model, wandelt es via Adapter in das `react-form-builder2`-Format um und nach dem Speichern wieder zurück.
4. **FHIR Mapping**: Ein Inspector im UI ermöglicht das Zuweisen von FHIR-Attributen für das jeweilige Feld.
5. **Export**: Services wandeln das Canonical Form Model in das Zielformat `CambioForm.v1.1` um.
