import { CanonicalForm, FormElementLayout } from 'core';

// Check if a layout node (or its children) has any non-empty values
export function hasValues(
  node: FormElementLayout,
  parentInstanceId: string,
  repeatInstances: Record<string, string[]>,
  fieldValues: Record<string, any>
): boolean {
  if (node.type === 'container') {
    const instancesKey = `${parentInstanceId}/${node.id}`;
    const instances = repeatInstances[instancesKey] || [];
    if (node.repeatable === true) {
      if (instances.length > 0) {
        return instances.some(instId => {
          return node.children?.some(child => hasValues(child, instId, repeatInstances, fieldValues)) ?? false;
        });
      }
      return false;
    }
    return node.children?.some(child => hasValues(child, parentInstanceId, repeatInstances, fieldValues)) ?? false;
  }

  // Leaf field
  if (node.repeatable === true) {
    const instancesKey = `${parentInstanceId}/${node.id}`;
    const instances = repeatInstances[instancesKey] || [];
    return instances.some(instId => {
      const val = fieldValues[instId];
      return val !== undefined && val !== null && val !== '';
    });
  } else {
    const valKey = `${parentInstanceId}/${node.id}`;
    const val = fieldValues[valKey];
    return val !== undefined && val !== null && val !== '';
  }
}

// Validate a single value
function validateValue(
  node: FormElementLayout,
  val: any,
  errorKey: string,
  errors: Record<string, string>
) {
  const isEmpty = val === undefined || val === null || val === '';

  if (node.required && isEmpty) {
    errors[errorKey] = `Field "${node.label}" is required.`;
    return;
  }

  if (node.type === 'input-quantity') {
    if (!isEmpty) {
      const magnitude = val.magnitude;
      const unit = val.unit;
      const magEmpty = magnitude === undefined || magnitude === null || magnitude === '';
      const unitEmpty = unit === undefined || unit === null || unit === '';
      if (magEmpty || unitEmpty) {
        errors[errorKey] = `Field "${node.label}" requires both value and unit.`;
      }
    }
  }

  // Range validation
  if (!isEmpty && (node.type === 'input-quantity' || node.type === 'input-proportion')) {
    const magnitude = node.type === 'input-quantity' ? Number(val.magnitude) : Number(val);
    if (!isNaN(magnitude)) {
      if (node.validation?.min !== undefined && magnitude < node.validation.min) {
        errors[errorKey] = `Value for "${node.label}" must be at least ${node.validation.min}.`;
      }
      if (node.validation?.max !== undefined && magnitude > node.validation.max) {
        errors[errorKey] = `Value for "${node.label}" must be at most ${node.validation.max}.`;
      }
    }
  }
}

// Recursively validate layout tree
export function validateForm(
  node: FormElementLayout,
  parentInstanceId: string,
  repeatInstances: Record<string, string[]>,
  fieldValues: Record<string, any>,
  errors: Record<string, string>
) {
  if (node.type === 'container') {
    const isRepeat = node.repeatable === true;
    const min = node.repeatMin ?? 0;
    const max = node.repeatMax ?? -1;
    const instancesKey = `${parentInstanceId}/${node.id}`;
    const instances = repeatInstances[instancesKey] || [];

    if (isRepeat) {
      if (instances.length < min) {
        errors[node.id!] = `Group "${node.label}" requires at least ${min} entries.`;
      }
      if (max !== -1 && instances.length > max) {
        errors[node.id!] = `Group "${node.label}" allows at most ${max} entries.`;
      }
      instances.forEach(instId => {
        node.children?.forEach(child => validateForm(child, instId, repeatInstances, fieldValues, errors));
      });
      return;
    }

    // Optional group
    if (min === 0) {
      const isActive = hasValues(node, parentInstanceId, repeatInstances, fieldValues);
      if (!isActive) return; // Skip validation
    }

    node.children?.forEach(child => validateForm(child, parentInstanceId, repeatInstances, fieldValues, errors));
    return;
  }

  // Leaf field
  const isRepeat = node.repeatable === true;
  const min = node.repeatMin ?? 0;
  const max = node.repeatMax ?? -1;
  const instancesKey = `${parentInstanceId}/${node.id}`;
  const instances = repeatInstances[instancesKey] || [];

  if (isRepeat) {
    if (instances.length < min) {
      errors[node.id!] = `Field "${node.label}" requires at least ${min} entries.`;
    }
    if (max !== -1 && instances.length > max) {
      errors[node.id!] = `Field "${node.label}" allows at most ${max} entries.`;
    }
    instances.forEach(instId => {
      const val = fieldValues[instId];
      validateValue(node, val, instId, errors);
    });
  } else {
    const valKey = `${parentInstanceId}/${node.id}`;
    const val = fieldValues[valKey];
    validateValue(node, val, valKey, errors);
  }
}

// Format technical flat path with indices
function formatIndexedPath(flatPath: string, indexMap: Record<string, number>): string {
  const segments = flatPath.split('/');
  const indexedSegments = segments.map(seg => {
    if (indexMap[seg] !== undefined) {
      return `${seg}:${indexMap[seg]}`;
    }
    return seg;
  });
  return indexedSegments.join('/');
}

// Export single field value to Flat JSON
function exportFieldValue(
  node: FormElementLayout,
  binding: any,
  val: any,
  indexMap: Record<string, number>,
  flatJson: Record<string, any>
) {
  const isEmpty = val === undefined || val === null || val === '';
  if (isEmpty && !node.required) return; // Skip optional empty fields

  const path = formatIndexedPath(binding.flatPath, indexMap);

  if (binding.rmType === 'DV_CODED_TEXT' || binding.rmType === 'CODE_PHRASE') {
    if (!isEmpty) {
      const matchedOpt = node.options?.find(o => o.value === val);
      flatJson[`${path}|code`] = val;
      flatJson[`${path}|value`] = matchedOpt ? matchedOpt.text : val;
      flatJson[`${path}|terminology`] = 'local';
    }
  } else if (binding.rmType === 'DV_QUANTITY') {
    if (!isEmpty && val.magnitude !== undefined && val.magnitude !== '') {
      flatJson[`${path}|magnitude`] = Number(val.magnitude);
      flatJson[`${path}|unit`] = val.unit || '';
    }
  } else if (binding.rmType === 'DV_BOOLEAN') {
    if (val === true || val === 'true') {
      flatJson[path] = true;
    } else if (val === false || val === 'false') {
      flatJson[path] = false;
    }
  } else {
    if (!isEmpty) {
      flatJson[path] = val;
    }
  }
}

// Recursively build openEHR Flat JSON
export function exportToOpenEhrFlatJson(
  canonicalForm: CanonicalForm,
  repeatInstances: Record<string, string[]>,
  fieldValues: Record<string, any>
): Record<string, any> {
  const flatJson: Record<string, any> = {};

  // Add default context values
  flatJson['ctx/language'] = 'de';
  flatJson['ctx/territory'] = 'DE';
  flatJson['ctx/time'] = new Date().toISOString();
  flatJson['ctx/composer_name'] = 'Antigravity Formbuilder';

  function traverse(
    node: FormElementLayout,
    parentInstanceId: string,
    indexMap: Record<string, number>
  ) {
    if (node.type === 'container') {
      const isRepeat = node.repeatable === true;
      const min = node.repeatMin ?? 0;
      const instancesKey = `${parentInstanceId}/${node.id}`;
      const instances = repeatInstances[instancesKey] || [];

      if (isRepeat) {
        instances.forEach((instId, index) => {
          const nextIndexMap = { ...indexMap, [node.id!]: index };
          node.children?.forEach(child => traverse(child, instId, nextIndexMap));
        });
      } else {
        if (min === 0) {
          const isActive = hasValues(node, parentInstanceId, repeatInstances, fieldValues);
          if (!isActive) return;
        }
        node.children?.forEach(child => traverse(child, parentInstanceId, indexMap));
      }
      return;
    }

    // Leaf field
    const binding = canonicalForm.bindings?.[node.name!]?.openehr || node.binding?.openehr;
    if (!binding || !binding.flatPath) return;

    const isRepeat = node.repeatable === true;
    const instancesKey = `${parentInstanceId}/${node.id}`;
    const instances = repeatInstances[instancesKey] || [];

    if (isRepeat) {
      instances.forEach((instId, index) => {
        const nextIndexMap = { ...indexMap, [node.id!]: index };
        const val = fieldValues[instId];
        exportFieldValue(node, binding, val, nextIndexMap, flatJson);
      });
    } else {
      const valKey = `${parentInstanceId}/${node.id}`;
      const val = fieldValues[valKey];
      exportFieldValue(node, binding, val, indexMap, flatJson);
    }
  }

  // Start traversal from children of the layout's root container
  const rootContainer = canonicalForm.layout.children?.[0];
  if (rootContainer && rootContainer.children) {
    rootContainer.children.forEach(child => traverse(child, 'root', {}));
  }

  return flatJson;
}

export function findFilledTitleValues(
  containerNode: FormElementLayout,
  instanceId: string,
  fieldValues: Record<string, any>
): string[] {
  const titleFields = [
    "name", "diagnose", "diagnosis", "arzneimittel", "medication", 
    "substance", "datum", "date", "code", "value"
  ];
  const collected: string[] = [];

  function traverse(node: FormElementLayout) {
    if (node.type === 'container') {
      if (!node.repeatable) {
        node.children?.forEach(traverse);
      }
      return;
    }

    const nodeIdLower = node.id?.toLowerCase() || '';
    const nodeNameLower = node.name?.toLowerCase() || '';
    
    const matches = titleFields.some(tf => nodeIdLower.includes(tf) || nodeNameLower.includes(tf));
    if (matches) {
      const valKey = `${instanceId}/${node.id}`;
      const val = fieldValues[valKey];
      if (val !== undefined && val !== null && val !== '') {
        if (typeof val === 'object' && val.magnitude !== undefined) {
          collected.push(`${val.magnitude} ${val.unit || ''}`.trim());
        } else if (Array.isArray(val)) {
          if (val.length > 0) collected.push(val.join(', '));
        } else {
          collected.push(String(val));
        }
      }
    }
  }

  containerNode.children?.forEach(traverse);
  return collected;
}

export function getInstanceTitle(
  node: FormElementLayout,
  instanceId: string,
  index: number,
  fieldValues: Record<string, any>
): string {
  const values = findFilledTitleValues(node, instanceId, fieldValues);
  if (values.length > 0) {
    return values.slice(0, 2).join(' · ');
  }
  return `${node.label} ${index + 1}`;
}
