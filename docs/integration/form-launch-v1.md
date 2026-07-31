# Form Launch v1

`POST /api/form-launches` is the supported host interface for opening a published WatEHR form. It creates an authorized form session on the server and returns an embed URL containing only that session ID.

## Request

```json
{
  "protocolVersion": "watehr.form-launch.v1",
  "formId": "published-form-id",
  "patient": { "id": "PAT-42", "namespace": "default" },
  "mode": "edit",
  "load": "provider",
  "initialValues": { "encounter_note": "KIS context" },
  "providerReference": "optional openEHR version UID",
  "launchId": "host-correlation-id",
  "encounterId": "optional-host-context"
}
```

Only `create`, `edit`, `view`, and `prefill` are accepted as modes. `load: "provider"` loads existing provider data before rendering; `initialValues` then override loaded values. The endpoint accepts only published forms and applies the authenticated caller's session ownership.

## Response and embedding

The response includes `launchUrl`, for example `/embed/forms/<form-id>?sessionId=<id>`. Embed it in an iframe and append `hostOrigin` with the exact host origin. The web client helper `launchEmbeddedForm` and `formEmbedUrl` in `apps/web/src/integration/formLaunch.ts` implement this flow.

The frame sends `postMessage` events to that origin:

```ts
{ protocolVersion: 'watehr.form-launch.v1', event: 'loaded' | 'submitted' | 'error', formId, sessionId?, launchId?, message? }
```

Hosts must verify both `event.origin` and `protocolVersion`. Patient identity and initial values are never put into the embed URL.

## Mini-KIS proof

The **KIS-Arbeitsplatz** tab of a patient maps workflow cards to published forms through their source template IDs. It includes ServiceRequest, Specimen, ObservationLab, DiagnosticReportLab, Diagnosis, Procedure, MedicationAdministration, MedicationStatement and Person. This is a working consumer of the same public interface rather than a separate, hard-coded execution path.
