import { CanonicalForm } from 'core';
import { HttpError } from '../middleware/errorHandler';

function cleanChars(str: string): string {
  return str
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-zA-Z0-9_]/g, '_');
}

function normalizeTemplateReference(template: CanonicalForm['sourceTemplates'][number]) {
  // EHRbase web templates keep the clinical template version in `semVer`, but
  // older imports stored the web-template schema version (for example 2.3) in
  // this field and left the real version attached to the template id.
  const versionedId = template.id.match(/^(.*)\.v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  const id = template.id;
  const version = versionedId?.[2] || template.version;

  return {
    id,
    version,
    // Cambio resolves this reference to the OPT and derives an .opt filename.
    type: 'openEhrOpt14Template'
  };
}

function normalizeFieldName(originalName: string, templateAlias: string, newAlias: string): string {
  let nameWithoutAlias = originalName;
  if (nameWithoutAlias.startsWith(templateAlias + '_')) {
    nameWithoutAlias = nameWithoutAlias.substring(templateAlias.length + 1);
  } else if (nameWithoutAlias.startsWith(templateAlias)) {
    nameWithoutAlias = nameWithoutAlias.substring(templateAlias.length);
  }
  
  // Strip trailing hash suffix like _8cef or similar (4 to 8 hex/alphanumeric chars)
  let coreName = nameWithoutAlias.replace(/_[a-f0-9A-Z]{4,8}$/i, '');
  
  // Clean characters
  coreName = cleanChars(coreName).replace(/__+/g, '_').replace(/^_+|_+$/g, '');
  
  return `${newAlias}_${coreName}`;
}

function normalizeLayoutTree(node: any): any {
  if (!node) return null;

  if (node.type === 'form') {
    let children = (node.children || []).map(normalizeLayoutTree).filter((c: any) => c !== null);
    children = children.map((child: any) => {
      if (child.type !== 'container') {
        return normalizeLayoutTree({
          type: 'container',
          children: [child]
        });
      }
      return child;
    });
    return {
      ...node,
      children
    };
  }

  if (node.type === 'container') {
    let children = (node.children || []).map(normalizeLayoutTree).filter((c: any) => c !== null);
    if (children.length === 0) return null;
    children = children.map((child: any) => {
      if (child.type !== 'row') {
        if (child.type === 'column') {
          return normalizeLayoutTree({
            type: 'row',
            children: [child]
          });
        }
        return normalizeLayoutTree({
          type: 'row',
          children: [
            {
              type: 'column',
              spanlarge: 12,
              spanmedium: 8,
              spansmall: 4,
              children: [child]
            }
          ]
        });
      }
      return child;
    });
    return {
      ...node,
      children
    };
  }

  if (node.type === 'row') {
    let children = (node.children || []).map(normalizeLayoutTree).filter((c: any) => c !== null);
    if (children.length === 0) return null;
    children = children.map((child: any) => {
      if (child.type !== 'column') {
        return normalizeLayoutTree({
          type: 'column',
          spanlarge: 12,
          spanmedium: 8,
          spansmall: 4,
          children: [child]
        });
      }
      return child;
    });
    return {
      ...node,
      children
    };
  }

  if (node.type === 'column') {
    let children = (node.children || []).map(normalizeLayoutTree).filter((c: any) => c !== null);
    if (children.length === 0) return null;
    const spanlarge = node.spanLarge ?? node.spanlarge ?? 12;
    const spanmedium = node.spanMedium ?? node.spanmedium ?? 8;
    const spansmall = node.spanSmall ?? node.spansmall ?? 4;
    return {
      ...node,
      spanlarge,
      spanmedium,
      spansmall,
      children
    };
  }

  return node;
}

export function exportToCambioForm(form: CanonicalForm): any {
  // 1. Normalize template aliases to T0, T1, ...
  const templateAliasMap = new Map<string, string>();
  const normalizedTemplates = (form.sourceTemplates || []).map((t, index) => {
    const newAlias = `T${index}`;
    templateAliasMap.set(t.alias, newAlias);
    const reference = normalizeTemplateReference(t);
    return {
      alias: newAlias,
      ...reference
    };
  });

  // 2. Map original field names to stable normalized names
  const fieldNameMap = new Map<string, string>();
  const usedNormalizedNames = new Set<string>();

  function collectFieldNames(node: any) {
    if (!node) return;
    if (node.name) {
      const originalName = node.name;
      const originalAlias = form.bindings?.[originalName]?.openehr?.templateAlias || (form.sourceTemplates?.[0]?.alias || '');
      const newAlias = templateAliasMap.get(originalAlias) || 'T0';
      let normalized = normalizeFieldName(originalName, originalAlias, newAlias);
      
      if (usedNormalizedNames.has(normalized)) {
        let counter = 1;
        while (usedNormalizedNames.has(`${normalized}_${counter}`)) {
          counter++;
        }
        normalized = `${normalized}_${counter}`;
      }
      usedNormalizedNames.add(normalized);
      fieldNameMap.set(originalName, normalized);
    }
    if (node.children) {
      for (const child of node.children) {
        collectFieldNames(child);
      }
    }
  }
  collectFieldNames(form.layout);

  // 3. Clean tree of system fields and empty containers
  function cleanLayoutTree(node: any): any {
    if (!node) return null;
    
    if (node.children) {
      const cleanedChildren = node.children
        .map((child: any) => cleanLayoutTree(child))
        .filter((child: any) => child !== null);
      
      if (node.type === 'container' && cleanedChildren.length === 0) {
        return null;
      }
      
      return {
        ...node,
        children: cleanedChildren
      };
    }
    
    return { ...node };
  }

  const filteredLayout = cleanLayoutTree(form.layout);
  if (!filteredLayout) {
    throw new HttpError(400, "Form layout is empty after filtering system fields");
  }

  // 4. Validate duplicates on filtered tree
  const seenPaths = new Map<string, string>();
  const seenFlatPaths = new Map<string, string>();

  function validateDuplicates(node: any) {
    if (!node) return;
    if (node.name) {
      const binding = form.bindings?.[node.name]?.openehr;
      if (binding) {
        if (binding.path) {
          if (seenPaths.has(binding.path)) {
            throw new HttpError(400, `Duplicate openEHR path detected: ${binding.path} (fields: ${seenPaths.get(binding.path)}, ${node.name})`);
          }
          seenPaths.set(binding.path, node.name);
        }
        if (binding.flatPath) {
          if (seenFlatPaths.has(binding.flatPath)) {
            throw new HttpError(400, `Duplicate flatPath detected: ${binding.flatPath} (fields: ${seenFlatPaths.get(binding.flatPath)}, ${node.name})`);
          }
          seenFlatPaths.set(binding.flatPath, node.name);
        }
      }
    }
    if (node.children) {
      for (const child of node.children) {
        validateDuplicates(child);
      }
    }
  }
  validateDuplicates(filteredLayout);

  // 5. Construct locales dictionary
  const newLocales: Record<string, Record<string, any>> = {};
  const languages = Object.keys(form.locales || {});
  if (languages.length === 0) {
    languages.push('en');
  }
  for (const lang of languages) {
    newLocales[lang] = {};
  }

  // 6. Transform the layout nodes recursively
  function transformNode(node: any): any {
    if (!node) return null;
    
    if (node.type === 'form') {
      const children = (node.children || []).map(transformNode).filter((c: any) => c !== null);
      return {
        type: 'form',
        children
      };
    }
    
    if (node.type === 'container') {
      const children = (node.children || []).map(transformNode).filter((c: any) => c !== null);
      if (children.length === 0) return null;
      const transformedContainer: any = {
        type: 'container',
        children
      };
      if (node.collapsible !== undefined) {
        transformedContainer.collapsible = node.collapsible;
      }
      if (node.initiallyCollapsed !== undefined) {
        transformedContainer.initiallyCollapsed = node.initiallyCollapsed;
      }
      return transformedContainer;
    }
    
    if (node.type === 'row') {
      const children = (node.children || []).map(transformNode).filter((c: any) => c !== null);
      if (children.length === 0) return null;
      const transformedRow: any = {
        type: 'row',
        children
      };
      if (node.gap !== undefined) {
        transformedRow.gap = node.gap;
      }
      return transformedRow;
    }
    
    if (node.type === 'column') {
      const children = (node.children || []).map(transformNode).filter((c: any) => c !== null);
      if (children.length === 0) return null;
      return {
        type: 'column',
        spanlarge: node.spanlarge,
        spanmedium: node.spanmedium,
        spansmall: node.spansmall,
        children
      };
    }
    
    // Static text or layout fields (e.g. headers, paragraphs, line-breaks)
    if (['header', 'paragraph', 'line-break'].includes(node.type)) {
      const transformed: any = { type: node.type };
      if (node.content !== undefined) transformed.content = node.content;
      return transformed;
    }
    
    if (node.type === 'submit-button') {
      return {
        type: 'submit-button',
        justify: node.justify || 'end',
        id: node.id || 'submit_button'
      };
    }

    // Leaf input field
    const newName = fieldNameMap.get(node.name) || node.name;
    const transformedField: any = {
      // CambioForm.v1.1 calls the combined control `input-datetime`.
      type: node.type === 'input-date-time' ? 'input-datetime' : node.type,
      name: newName
    };
    
    for (const lang of languages) {
      const originalLabel = form.locales?.[lang]?.[`[name='${node.name}']`]?.label || form.locales?.[lang]?.[node.name]?.label || node.label || node.name || '';
      
      newLocales[lang][`[name='${newName}']`] = {
        label: originalLabel
      };
      
      if (node.type === 'input-select') {
        if (node.options && Array.isArray(node.options)) {
          const cleanedOptions = node.options.map((opt: any) => {
            const valStr = String(opt.value || '');
            const txtStr = String(opt.text || '');
            if (valStr === 'option_1' || valStr === 'option_2' || txtStr === 'Option 1' || txtStr === 'Option 2') {
              return null;
            }
            return {
              text: txtStr,
              value: valStr
            };
          }).filter((option: any) => option !== null);
          if (cleanedOptions.length > 0) {
            newLocales[lang][`[name='${newName}']`].options = cleanedOptions;
          }
        }
      }
    }
    
    if (node.type === 'input-select') {
      transformedField.clearable = node.clearable ?? true;
      transformedField.display = node.display ?? 'dropdown';
    } else if (node.type === 'input-quantity') {
      const unitOptionsSource = node.unitOptions || node.unitoptions || [];
      let validUnitOptions = unitOptionsSource
        .filter((u: any) => u && typeof u.unit === 'string' && u.unit.trim() !== '')
        .map((u: any) => {
          const opt: any = { unit: u.unit };
          if (u.min !== undefined && u.min !== null) opt.min = u.min;
          if (u.minexclusive !== undefined && u.minexclusive !== null) opt.minexclusive = u.minexclusive;
          if (u.max !== undefined && u.max !== null) opt.max = u.max;
          if (u.maxexclusive !== undefined && u.maxexclusive !== null) opt.maxexclusive = u.maxexclusive;
          if (u.precision !== undefined && u.precision !== null) opt.precision = u.precision;
          return opt;
        });
      
      if (validUnitOptions.length === 0) {
        const fallbackUnit = node.unit || 'cm';
        validUnitOptions = [{ unit: fallbackUnit }];
      }
      
      transformedField.unitoptions = validUnitOptions;
    }
    
    return transformedField;
  }

  // First pass: Normalize the structural layout (wrap loose fields/elements in row/columns)
  const normalizedLayout = normalizeLayoutTree(filteredLayout);

  // Second pass: Transform the layout nodes and leaf fields
  const transformedLayout = transformNode(normalizedLayout);

  // 7. Append exactly one submit button to the last column (only if one does not already exist)
  if (transformedLayout) {
    let hasSubmitButton = false;
    function checkSubmit(current: any) {
      if (!current || hasSubmitButton) return;
      if (current.type === 'submit-button') {
        hasSubmitButton = true;
        return;
      }
      if (current.children) {
        for (const child of current.children) {
          checkSubmit(child);
        }
      }
    }
    checkSubmit(transformedLayout);

    if (!hasSubmitButton) {
      let lastColumn: any = null;
      function findLastColumn(current: any) {
        if (!current) return;
        if (current.type === 'column') {
          lastColumn = current;
        }
        if (current.children) {
          for (const child of current.children) {
            findLastColumn(child);
          }
        }
      }
      findLastColumn(transformedLayout);
      if (lastColumn) {
        if (!lastColumn.children) {
          lastColumn.children = [];
        }
        lastColumn.children.push({
          type: 'submit-button',
          justify: 'end',
          id: 'submit_button'
        });
      }
    }
  }

  // 8. Add #submit_button locale entry
  for (const lang of Object.keys(newLocales)) {
    newLocales[lang]['#submit_button'] = { label: 'Submit' };
  }

  // Parse authors in "Name <email>" format or fallback to name only
  const authors: any[] = [];
  if (form.settings?.authors) {
    const authorStr = form.settings.authors;
    const match = authorStr.match(/^(.*?)\s*<(.*?)>$/);
    if (match) {
      authors.push({
        name: match[1].trim(),
        email: match[2].trim()
      });
    } else {
      authors.push({
        name: authorStr.trim()
      });
    }
  }

  const cambio = {
    authors,
    updated: new Date().toISOString(),
    name: form.name || '',
    description: form.settings?.description || '',
    id: form.id,
    version: form.version || '0.1.0',
    format: 'CambioForm.v1.1',
    templates: normalizedTemplates,
    elements: transformedLayout ? [transformedLayout] : [],
    locales: newLocales
  };

  return cambio;
}
