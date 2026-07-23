import { CanonicalForm, FormElementLayout, FieldRegistryItem } from 'core';
import { v4 as uuidv4 } from 'uuid';

export function generateCanonicalForm(
  name: string,
  templateId: string,
  alias: string,
  fields: FieldRegistryItem[]
): CanonicalForm {
  const formId = uuidv4();
  
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

  const layout: FormElementLayout = {
    type: 'form',
    children: [
      {
        type: 'container',
        children
      }
    ]
  };

  // Generate Bindings and Locales
  const bindings: Record<string, any> = {};
  const localesEn: Record<string, any> = {};

  fields.forEach(field => {
    bindings[field.fieldName] = {
      openehr: {
        templateAlias: field.templateAlias,
        path: field.openehrPath,
        rmType: field.rmType
      }
    };

    localesEn[`[name='${field.fieldName}']`] = {
      label: field.label
    };
  });

  const form: CanonicalForm = {
    id: formId,
    name,
    version: '0.1.0-draft',
    sourceTemplates: [
      {
        alias,
        id: templateId,
        version: '0.1.0',
        type: 'openEhrWebTemplate'
      }
    ],
    layout,
    bindings,
    locales: {
      en: localesEn
    },
  };

  return form;
}
