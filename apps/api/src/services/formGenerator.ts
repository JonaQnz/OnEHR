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
  
  // Create a basic layout: one column per field, wrapped in a row, wrapped in a container
  const children: FormElementLayout[] = fields.map((field) => {
    let inputType = 'input-text';
    if (field.dataType === 'quantity') inputType = 'input-quantity';
    if (field.dataType === 'select') inputType = 'input-select';
    if (field.dataType === 'proportion') inputType = 'input-proportion';

    const inputComponent: FormElementLayout = {
      type: inputType,
      name: field.fieldName
    };

    if (inputType === 'input-quantity' && field.constraints?.units) {
      inputComponent.unitOptions = field.constraints.units.map(u => ({ unit: u }));
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
