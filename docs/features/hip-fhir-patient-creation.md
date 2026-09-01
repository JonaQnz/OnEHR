# HIP FHIR patient creation

Patient creation follows the active system connection:

- `none` or `basic`: the existing EHRbase `/ehr` flow remains unchanged.
- `hip-keycloak`: Forms opens the configured Person form and creates an ISiK
  FHIR R4 `Patient`. There is no silent EHRbase fallback when HIP FHIR settings
  are incomplete.

The HIP connection settings provide the FHIR API base URL, optional Mapping
Service API URL, ISiK profile, published Person form and
the source-field mapping. Forms appends `/fhir/R4/Patient` when the configured
FHIR API is a service root. A complete R4 base or Patient endpoint is accepted
as well.

The FHIR request reuses the same server-side Keycloak token cache as EHRbase.
Tokens and service credentials never reach the browser. The PoC sends no
additional MR identifier.

After the FHIR server confirms the Patient, Forms does not create a local
patient row or an EHR. It returns to the patient list and invalidates the
normal one-minute EHRbase synchronization throttle. The next list load asks
the HIP-backed EHRbase registry for the patient and its linked EHR.

The proof of concept maps these fixed targets:

- given and family name
- birth date and administrative gender
- GKV/PKV insurance number
- street, house number, city, postal code and country

It deliberately does not implement arbitrary FHIRPath mappings, updates,
deletes or bidirectional synchronization.
