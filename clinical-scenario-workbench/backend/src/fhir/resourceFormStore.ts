import { readJsonFile, writeJsonFile } from '../world/jsonStore';
import type { BlueprintLoader } from './blueprint';
import type { FhirFormField, FhirResourceForm } from './resourceForm';

type StoreFile = Record<string, FhirResourceForm>;

/**
 * JSON-backed CRUD + versioning for FhirResourceForms (spec sections 8/12) -
 * one form per resource type for this POC (its `id` is just the lowercased
 * resourceType), growing its `version`/`fields` over time rather than
 * spawning a new form per version. This is the ONE place a resource type's
 * form gets created (`ensureForm`, spec section 8's "Resource Form
 * vorhanden? NEIN -> Blueprint laden -> Form erzeugen -> registrieren" flow)
 * or grown (`addField`, spec section 12) - both the UI's ResourceFormManager
 * and the MCP `create_fhir_resource_form`/`update_fhir_resource_form` tools
 * call these same two methods, never a separate implementation each.
 */
export class ResourceFormStore {
  private forms: StoreFile;

  constructor(
    private readonly dataDir: string,
    private readonly scenarioRunId: string,
    private readonly blueprints: BlueprintLoader,
  ) {
    this.forms = readJsonFile<StoreFile>(dataDir, scenarioRunId, 'forms', {});
  }

  list(): FhirResourceForm[] {
    return Object.values(this.forms);
  }

  get(id: string): FhirResourceForm | undefined {
    return this.forms[id];
  }

  getByResourceType(resourceType: string): FhirResourceForm | undefined {
    return this.forms[formIdFor(resourceType)];
  }

  /** Returns the existing form for `resourceType`, or builds a fresh v1 from
   * that type's Blueprint (`fields`, verbatim) and registers it - spec
   * section 8's "no unsupported FHIR resource may be created before a
   * Resource Form exists for it" rule made concrete. Throws (via
   * BlueprintLoader.require) if no blueprint exists at all - a genuinely
   * unsupported resource type, not just a not-yet-generated form. */
  ensureForm(resourceType: string): FhirResourceForm {
    const existing = this.getByResourceType(resourceType);
    if (existing) return existing;
    const blueprint = this.blueprints.require(resourceType);
    const form: FhirResourceForm = {
      id: formIdFor(resourceType),
      resourceType,
      version: 1,
      fields: blueprint.fields.map((field) => ({ ...field })),
      createdBy: 'system',
      editable: true,
    };
    this.forms[form.id] = form;
    this.save();
    return form;
  }

  /** Spec section 12's form-growth flow: appends one field and bumps
   * `version`. Refuses a duplicate `path` (edit the existing field via
   * `updateField` instead of shadowing it) rather than silently producing
   * two fields with the same path, which would make validateAgainstForm's
   * `values[field.path]` lookup ambiguous. */
  addField(formId: string, field: FhirFormField): FhirResourceForm {
    const form = this.requireForm(formId);
    if (form.fields.some((existing) => existing.path === field.path)) {
      throw new Error(`Form "${formId}" already has a field at path "${field.path}" - use updateField to change it.`);
    }
    const updated: FhirResourceForm = { ...form, version: form.version + 1, fields: [...form.fields, field] };
    this.forms[formId] = updated;
    this.save();
    return updated;
  }

  updateField(formId: string, path: string, patch: Partial<FhirFormField>): FhirResourceForm {
    const form = this.requireForm(formId);
    const index = form.fields.findIndex((field) => field.path === path);
    if (index === -1) throw new Error(`Form "${formId}" has no field at path "${path}".`);
    const nextFields = form.fields.map((field, i) => (i === index ? { ...field, ...patch, path: field.path } : field));
    const updated: FhirResourceForm = { ...form, version: form.version + 1, fields: nextFields };
    this.forms[formId] = updated;
    this.save();
    return updated;
  }

  private requireForm(formId: string): FhirResourceForm {
    const form = this.forms[formId];
    if (!form) throw new Error(`No FhirResourceForm with id "${formId}".`);
    return form;
  }

  private save(): void {
    writeJsonFile(this.dataDir, this.scenarioRunId, 'forms', this.forms);
  }
}

function formIdFor(resourceType: string): string {
  return resourceType.toLowerCase();
}
