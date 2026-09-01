# onEHR basis import package — 2026-09-01

This package transports reusable onEHR definitions through the existing
onEHR REST API. It contains no database dump, SQL, WebTemplate, OPT XML,
patient data, users, sessions, credentials, tenant URLs, plugin secrets, or
integration logs.

## Contents

- 9 published Form Sections: the selected basis sections, including Person,
  medication and medication-administration sections.
- 7 published Compositions whose names contain `Einzelformular`.
- All 20 AQL Functions, all 13 Code Functions, and all 13 Data Widgets from
  the source installation.
- The enabled npm plugin package names. `hip-keycloak` is a built-in onEHR
  system-connection plugin, so no HIP connection or credential is exported.

`Person (Basis)` is included although its first publication was shortly
before the local 2026-09-01 window, because it belongs to the base set and is
referenced by the HIP FHIR patient-creation configuration.

The required remote template IDs are metadata in `manifest.json` only. The
package never uploads or imports a template. Before changing forms, the
importer only verifies with a GET request that each ID is available from the
target EHRbase.

## Import through the API

Run a mutation-free review first from the onEHR repository root:

```bash
ONEHR_DRY_RUN=1 \
ONEHR_API_URL=http://localhost:3001 \
ONEHR_USERNAME=admin \
ONEHR_PASSWORD='…' \
./deploy/import-packages/onehr-basis-2026-09-01/docker/import.sh
```

Then omit `ONEHR_DRY_RUN` to import. The script accepts
`ONEHR_SESSION_COOKIE` instead of username/password and also reads the
repository's existing `.env` without overriding explicitly supplied values.

The importer:

1. validates the package and remote template dependencies;
2. loads missing bundled npm plugins;
3. upserts AQL Functions, Code Functions and Data Widgets by stable names;
4. imports Form Sections, remaps all generated IDs, and publishes them;
5. imports and publishes the `Einzelformular` Compositions against those new
   IDs.

Imported forms receive an `onehr.importPackage` extension marker. Re-running
the package reuses already published marked forms and resumes marked drafts
left by an interrupted run. An unmarked published form with the same name
stops the import. Set `ONEHR_ALLOW_NAME_REUSE=1` only when deliberately mapping
to a single existing same-name form, such as for a dry-run against the source
installation.

## Refresh the checked-in package

The allowlisted definitions can be downloaded again from the source API:

```bash
ONEHR_API_URL=http://localhost:3001 \
ONEHR_USERNAME=admin \
ONEHR_PASSWORD='…' \
./deploy/import-packages/onehr-basis-2026-09-01/docker/export.sh
```

The exporter uses `/api/forms/:id/export/full` for forms and the corresponding
Functions, Widgets and Plugins endpoints. It writes one full-export JSON file
per form, regenerates `manifest.json`, and updates `SHA256SUMS`. It does not
call a template export endpoint or write template payloads.
