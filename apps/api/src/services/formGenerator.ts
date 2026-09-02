import { CanonicalForm, FormElementLayout, FieldRegistryItem } from 'core';
import { v4 as uuidv4 } from 'uuid';

export interface GenerateCanonicalFormInput {
  name: string;
  templateId: string;
  alias: string;
  fields: readonly FieldRegistryItem[];
  id?: string;
  templateVersion?: string;
  layout?: FormElementLayout;
}

export function generateCanonicalForm(
  { name, templateId, alias, fields, id, templateVersion = '1.0.0', layout }: GenerateCanonicalFormInput,
): CanonicalForm {
  const formId = id || uuidv4();

  function fieldRow(field: FieldRegistryItem): FormElementLayout {
    let inputType = 'input-text';
    if (field.dataType === 'quantity') inputType = 'input-quantity';
    if (field.dataType === 'select') inputType = 'input-select';
    if (field.dataType === 'proportion') inputType = 'input-proportion';
    if (field.dataType === 'ordinal') inputType = 'input-ordinal';

    const inputComponent: FormElementLayout = {
      type: inputType,
      name: field.fieldName
    };

    if (inputType === 'input-quantity' && field.constraints?.units) {
      // Prefer constraints.unitOptions (per-unit min/max/precision, parsed
      // straight from the archetype's own range/precision validation in
      // webTemplateParser) over rebuilding a bare {unit} from
      // constraints.units - the latter silently drops every magnitude/
      // precision limit the archetype actually specifies. See the sibling
      // fix in webTemplateParser.ts's apply_template_to_form path for the
      // live example (vg_MedicationAdministration "Frequenz").
      inputComponent.unitOptions = field.constraints.unitOptions
        ?? field.constraints.units.map(u => ({ unit: u }));
    }
    if (inputType === 'input-proportion' && field.constraints?.proportionType) {
      inputComponent.proportionType = field.constraints.proportionType;
    }
    // DV_ORDINAL's options (each carrying its archetype-fixed `ordinal`
    // integer alongside the symbol's code/text - see webTemplateParser.ts's
    // DV_ORDINAL extraction) were never copied onto the generated field at
    // all before this - this whole function has no `field.options` copy
    // for ANY select-like type (DV_CODED_TEXT's own 'select' dataType has
    // the exact same gap, pre-existing and out of scope for this fix -
    // apply_template_to_form's sibling generation path, unlike this one,
    // already copies `matchedField.options` through unconditionally,
    // which is presumably why the gap here was never noticed). Scoped
    // narrowly to 'ordinal' since that's what's actually being fixed here.
    if (inputType === 'input-ordinal' && field.options) {
      inputComponent.options = field.options;
    }

    return {
      type: 'row',
      children: [
        {
          type: 'column',
          spanLarge: 12,
          spanMedium: 12,
          spanSmall: 12,
          children: [inputComponent]
        }
      ]
    };
  }

  // Fields whose nearest enclosing CLUSTER/EVENT/ACTIVITY can itself repeat
  // in the source template (e.g. multiple analyte results in one lab
  // panel, multiple ICD entries in one multiple-coding cluster) are grouped
  // into a single repeatable container per cluster instead of N flat,
  // independent rows - one container the clinician can add/remove whole
  // instances of, each holding all of that cluster's picked fields
  // together. Fields with no repeatable ancestor keep the existing flat
  // one-row-per-field shape, unchanged.
  //
  // Grouped by the field's flatPath *up to and excluding its own last
  // segment* - a stronger key than parentTechnicalName alone, which is
  // only the cluster's bare archetype node id and would wrongly merge two
  // distinct occurrences of the same cluster type at different places in
  // the tree (e.g. vg_Diagnosis's identical `multiple_coding_icd10gm`
  // cluster appearing under both the primary- and secondary-diagnosis
  // context - two unrelated repeatable groups, not one).
  function groupKey(field: FieldRegistryItem): string {
    const path = field.flatPath || `${field.parentTechnicalName || field.parentName || 'group'}/${field.fieldName}`;
    const segments = path.split('/');
    return segments.slice(0, -1).join('/') || path;
  }
  const usedContainerIds = new Set<string>();
  function uniqueContainerId(base: string): string {
    let id = base || 'group';
    let suffix = 2;
    while (usedContainerIds.has(id)) { id = `${base}_${suffix}`; suffix += 1; }
    usedContainerIds.add(id);
    return id;
  }
  const repeatableGroups = new Map<string, { id: string; label: string; fields: FieldRegistryItem[]; repeatMin: number; repeatMax: number }>();
  const children: FormElementLayout[] = [];
  fields.forEach((field) => {
    if (!field.parentRepeatable) {
      children.push(fieldRow(field));
      return;
    }
    const key = groupKey(field);
    let group = repeatableGroups.get(key);
    if (!group) {
      group = {
        id: uniqueContainerId(field.parentTechnicalName || field.parentName || 'group'),
        label: field.parentName || field.parentTechnicalName || 'Group',
        fields: [],
        repeatMin: field.parentRepeatMin ?? 0,
        repeatMax: field.parentRepeatMax ?? -1,
      };
      repeatableGroups.set(key, group);
      // Reserve this cluster's position in document order the first time
      // any of its fields appears, so a repeatable group renders where its
      // first field was picked, not shoved to the end.
      children.push({
        type: 'container',
        id: group.id,
        label: group.label,
        repeatable: true,
        repeatMin: group.repeatMin,
        repeatMax: group.repeatMax,
        children: [],
      });
    }
    group.fields.push(field);
  });
  // Fill each reserved repeatable container with its fields' rows now that
  // every field has been assigned - a field can't populate its group until
  // the whole `fields` list has been walked, since group membership isn't
  // known until then.
  repeatableGroups.forEach((group) => {
    const container = children.find((node) => node.type === 'container' && node.id === group.id);
    if (container) container.children = group.fields.map(fieldRow);
  });

  const generatedLayout: FormElementLayout = {
    type: 'form',
    children: [
      {
        type: 'container',
        children
      }
    ]
  };

  // Generate Bindings and Locales
  const bindings: CanonicalForm['bindings'] = {};
  const localesEn: CanonicalForm['locales']['en'] = {};

  fields.forEach(field => {
    bindings[field.fieldName] = {
      openehr: {
        templateAlias: field.templateAlias,
        path: field.openehrPath,
        rmType: field.rmType,
        ...(field.flatPath ? { flatPath: field.flatPath } : {}),
        ...(field.archetypeNodeId ? { archetypeNodeId: field.archetypeNodeId } : {}),
        ...(field.archetypeId ? { archetypeId: field.archetypeId } : {}),
        ...(field.rmVersion ? { rmVersion: field.rmVersion } : {}),
        templateId: field.templateId,
        templateVersion,
      },
    };

    localesEn[`[name='${field.fieldName}']`] = {
      label: field.label
    };
  });

  // The parser only ever sees one field/node at a time, before this
  // function has decided *which* template version this form is actually
  // being generated against - so a parsed layout's own node.binding never
  // carries templateVersion yet. Stamp it on now, onto every node's
  // binding, so a layout node's binding is exactly as complete as the
  // (already-carrying-templateVersion) bindings map built above.
  function stampTemplateVersion(node: FormElementLayout): FormElementLayout {
    const children = node.children?.map(stampTemplateVersion);
    if (!node.binding) return children ? { ...node, children } : node;
    return { ...node, binding: { ...node.binding, templateVersion }, ...(children ? { children } : {}) };
  }

  const form: CanonicalForm = {
    id: formId,
    name,
    version: '0.1.0-draft',
    sourceTemplates: [
      {
        alias,
        id: templateId,
        version: templateVersion,
        type: 'openEhrWebTemplate'
      }
    ],
    layout: layout ? stampTemplateVersion(layout) : generatedLayout,
    bindings,
    locales: {
      en: localesEn
    },
  };

  return form;
}
