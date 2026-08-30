import { FieldRegistryItem, FieldConstraint, FormElementLayout, OpenEhrBinding } from 'core';
import { parseOpenEhrAqlPath } from 'openehr-engine';
import { v4 as uuidv4 } from 'uuid';

export function isContextOrIgnoredNode(node: any): boolean {
  if (!node) return false;
  if (node.inContext === true) return true;

  const id = (node.technicalName || node.id || '').toLowerCase();
  const rmType = (node.rmType || '').toUpperCase();
  const aqlPath = (node.openehrPath || node.aqlPath || '').toLowerCase();
  const flatPath = (node.flatPath || '').toLowerCase();

  const pathSegments = aqlPath.split('/').filter(Boolean);
  const lastSegment = pathSegments[pathSegments.length - 1] || '';
  const cleanLastSegment = lastSegment.split('[')[0].toLowerCase();

  const contextKeys = [
    'language', 'encoding', 'territory', 'composer', 
    'subject', 'category', 'setting', 'start_time', 'context'
  ];

  if (contextKeys.includes(id) || contextKeys.includes(cleanLastSegment)) {
    return true;
  }

  for (const key of contextKeys) {
    if (
      aqlPath.endsWith('/' + key) || 
      aqlPath.includes('/' + key + '/') || 
      aqlPath.includes('/' + key + '[') ||
      flatPath.endsWith('/' + key) ||
      flatPath.includes('/' + key + '/')
    ) {
      return true;
    }
  }

  return false;
}

function isTechnicalWrapper(node: any): boolean {
  if (!node.id && !node.rmType) return false;
  const id = node.id?.toUpperCase();
  const rm = node.rmType?.toUpperCase();
  return [
    "ITEM_TREE", "ITEM_LIST", "ITEM_TABLE", "DATA", "STATE", 
    "PROTOCOL", "HISTORY", "DESCRIPTION", "ITEM_SINGLE", "ITEM_STRUCTURE"
  ].includes(id) || [
    "ITEM_TREE", "ITEM_LIST", "ITEM_TABLE", "HISTORY", "ITEM_SINGLE", "ITEM_STRUCTURE"
  ].includes(rm);
}

function isEntryNode(node: any): boolean {
  if (!node.rmType) return false;
  return [
    "OBSERVATION", "EVALUATION", "INSTRUCTION", "ACTION", "ADMIN_ENTRY"
  ].includes(node.rmType.toUpperCase());
}

function isClusterLikeNode(node: any): boolean {
  if (!node.rmType) return false;
  return [
    "CLUSTER", "EVENT", "ACTIVITY"
  ].includes(node.rmType.toUpperCase());
}

function isElementNode(node: any): boolean {
  // Real EHRbase WebTemplate export gives a leaf node its DV_* (or
  // CODE_PHRASE) type directly as rmType - confirmed against a real
  // fixture (examples/templates/vital_signs_icu.webtemplate.json), which
  // never has a bare rmType==="ELEMENT" wrapper node at all. The previous
  // ELEMENT-only check meant every leaf fell through every branch here
  // (not a technical wrapper, not an entry/cluster, not "ELEMENT") down to
  // the fallback wrapper, which returns null for a truly childless node -
  // silently dropping every leaf field from this function's own generated
  // layout tree. traverseFlat's separate flat-field builder already uses
  // this same rm.startsWith('DV_') convention (see `isInput` above) -
  // this aligns the two so a leaf is recognized consistently by both.
  const rm = (node.rmType || '').toUpperCase();
  return rm === 'ELEMENT' || rm.startsWith('DV_') || rm === 'CODE_PHRASE';
}

/** Builds the openEHR identity for a structural/container layout node
 * (OBSERVATION/CLUSTER/SECTION/etc) directly from the raw WebTemplate node -
 * containers never appear in the flat `fields` registry (that's leaves
 * only), so unlike leaf ELEMENT nodes there's no FieldRegistryItem to pull
 * this from. Every layout node - leaf or container - ends up carrying its
 * own binding this way, so the tree has real openEHR identity throughout,
 * not just at its leaves. */
function containerBinding(node: any, alias: string, templateId: string): OpenEhrBinding | undefined {
  if (!node.rmType || !node.aqlPath) return undefined;
  return {
    templateAlias: alias,
    templateId,
    rmType: node.rmType,
    path: node.aqlPath,
    ...parseOpenEhrAqlPath(node.aqlPath),
  };
}

function isRepeatable(node: any): boolean {
  const max = typeof node.max === 'number' ? node.max : 1;
  return max === -1 || max > 1;
}

function getRepeatMeta(node: any): { repeatMin: number; repeatMax: number; repeatable: boolean } {
  const min = typeof node.min === 'number' ? node.min : 0;
  const max = typeof node.max === 'number' ? node.max : 1;
  const repeatable = max === -1 || max > 1;
  return { repeatMin: min, repeatMax: max, repeatable };
}
function getDataType(rmType: string): string {
  switch (rmType) {
    case 'DV_QUANTITY': return 'quantity';
    case 'DV_CODED_TEXT':
    case 'CODE_PHRASE': return 'select';
    case 'DV_PROPORTION': return 'proportion';
    case 'DV_DATE': return 'date';
    case 'DV_DATE_TIME': return 'date-time';
    case 'DV_TIME': return 'time';
    case 'DV_BOOLEAN': return 'boolean';
    case 'DV_DURATION': return 'duration';
    case 'DV_ORDINAL': return 'ordinal';
    case 'DV_COUNT':
    case 'DV_INTEGER':
    case 'DV_DECIMAL': return 'number';
    case 'DV_URI': return 'uri';
    default: return 'string';
  }
}

function getInputType(dataType: string): string {
  switch (dataType) {
    case 'quantity': return 'input-quantity';
    case 'proportion': return 'input-proportion';
    case 'select':
    case 'ordinal':
    case 'boolean': return 'input-select';
    case 'date': return 'input-date';
    case 'date-time': return 'input-date-time';
    case 'time': return 'input-time';
    case 'number': return 'input-number';
    case 'duration': return 'input-duration';
    case 'uri': return 'input-uri';
    default: return 'input-text';
  }
}

export function parseWebTemplate(webTemplate: any): { 
  templateId: string; 
  alias: string; 
  fields: FieldRegistryItem[]; 
  layout: FormElementLayout;
} {
  const templateId = webTemplate.templateId || 'unknown_template';
  const alias = webTemplate.tree?.id || 'T0';
  const fields: FieldRegistryItem[] = [];
  const idCounts: Record<string, number> = {};

  // 1. First, build the flat fields registry (traversing leaves only)
  function traverseFlat(
    node: any,
    parentName: string,
    currentFlatPath: string,
    parentTechnicalName: string,
    // The nearest enclosing CLUSTER/EVENT/ACTIVITY's own repeat meta, if
    // any is on the ancestor path - reset to undefined the moment we
    // descend past that cluster's own boundary into a *different*,
    // non-repeatable container, so a field only inherits the closest
    // repeatable group, never a repeatable grandparent through a
    // non-repeatable parent. Mirrors isClusterLikeNode/getRepeatMeta below
    // exactly, so this flat registry always agrees with what the second
    // pass (buildLayoutNode) would build for the same node.
    parentRepeat?: { repeatable: boolean; repeatMin: number; repeatMax: number },
  ) {
    if (!node) return;
    if (isContextOrIgnoredNode(node)) return;

    let nextParentName = parentName;
    let nextParentTechnicalName = parentTechnicalName;
    let nextParentRepeat = parentRepeat;
    const isContainer = node.rmType && [
      'COMPOSITION', 'SECTION', 'OBSERVATION', 'EVALUATION',
      'INSTRUCTION', 'ACTION', 'ADMIN_ENTRY', 'CLUSTER', 'ELEMENT'
    ].includes(node.rmType);

    if (isContainer && node.name) {
      nextParentName = node.name;
    }
    if (isContainer && node.id) {
      nextParentTechnicalName = node.id;
    }
    if (isClusterLikeNode(node)) {
      nextParentRepeat = getRepeatMeta(node);
    }

    let nextFlatPath = currentFlatPath;
    if (node.id) {
      nextFlatPath = currentFlatPath ? `${currentFlatPath}/${node.id}` : node.id;
    }

    if (node.rmType && node.aqlPath && node.id) {
      const rm = node.rmType;
      const isInput = rm.startsWith('DV_') || rm === 'CODE_PHRASE';
      if (isInput) {
        const baseId = node.id;
        idCounts[baseId] = (idCounts[baseId] || 0) + 1;
        const uniqueId = idCounts[baseId] === 1 ? baseId : `${baseId}_${idCounts[baseId]}`;

        const dataType = getDataType(rm);
        const parsedPath = parseOpenEhrAqlPath(node.aqlPath);

        const field: FieldRegistryItem = {
          fieldName: `${alias}_${uniqueId}`,
          label: node.name || node.id,
          templateAlias: alias,
          templateId: templateId,
          rmType: node.rmType,
          dataType: dataType,
          openehrPath: node.aqlPath,
          required: node.min >= 1,
          maxOccurrences: typeof node.max === 'number' ? node.max : -1,
          technicalName: node.id || '',
          parentName: parentName || 'Other',
          parentTechnicalName: parentTechnicalName || alias,
          flatPath: nextFlatPath,
          ...parsedPath,
          ...(parentRepeat?.repeatable ? {
            parentRepeatable: true,
            parentRepeatMin: parentRepeat.repeatMin,
            parentRepeatMax: parentRepeat.repeatMax,
          } : {}),
        };

        if (node.rmType === 'DV_QUANTITY' && node.inputs) {
          const unitInput = node.inputs.find((i: any) => i.suffix === 'units' || i.suffix === 'unit' || i.suffix === 'unit_code');
          const constraints: FieldConstraint = {};
          if (unitInput && unitInput.list && unitInput.list.length > 0) {
            constraints.units = unitInput.list.map((l: any) => l.value);
            
            constraints.unitOptions = unitInput.list.map((l: any) => {
              const opt: any = { unit: l.value };
              if (l.validation) {
                if (l.validation.range) {
                  if (l.validation.range.min !== undefined) opt.min = l.validation.range.min;
                  if (l.validation.range.max !== undefined) opt.max = l.validation.range.max;
                  if (l.validation.range.minOp === '>') opt.minexclusive = true;
                  if (l.validation.range.maxOp === '<') opt.maxexclusive = true;
                }
                if (l.validation.precision) {
                  if (l.validation.precision.max !== undefined) opt.precision = l.validation.precision.max;
                  else if (l.validation.precision.min !== undefined) opt.precision = l.validation.precision.min;
                }
              }
              return opt;
            });
          }
          field.constraints = constraints;
        }

        const needsOptions = (node.rmType === 'DV_CODED_TEXT' || node.rmType === 'CODE_PHRASE');
        if (needsOptions && node.inputs) {
          const codeInput = node.inputs.find((i: any) => i.suffix === 'code' || i.type === 'CODED_TEXT');
          const listInput = codeInput || node.inputs[0];
          if (listInput && listInput.list) {
            field.options = listInput.list.map((l: any) => ({
              value: l.value,
              text: l.label || l.value
            }));
          }
        }

        if (node.rmType === 'DV_BOOLEAN') {
          field.options = [
            { value: 'true', text: 'Yes' },
            { value: 'false', text: 'No' }
          ];
        }

        fields.push(field);
      }
    }

    if (node.children) {
      node.children.forEach((child: any) => traverseFlat(child, nextParentName, nextFlatPath, nextParentTechnicalName, nextParentRepeat));
    }
  }

  if (webTemplate.tree) {
    traverseFlat(webTemplate.tree, 'Other', '', alias);
  }

  // Reset ID counts for layout unique field names mapping
  const layoutIdCounts: Record<string, number> = {};
  function getUniqueFieldName(nodeId: string): string {
    layoutIdCounts[nodeId] = (layoutIdCounts[nodeId] || 0) + 1;
    const count = layoutIdCounts[nodeId];
    return count === 1 ? `${alias}_${nodeId}` : `${alias}_${nodeId}_${count}`;
  }

  // Same disambiguation for CONTAINER ids (OBSERVATION/EVALUATION/CLUSTER/
  // SECTION wrappers, not leaf fields) - a repeatable container's id is also
  // a real runtime key (GroupItems[groupId] in the generated FormScript
  // types), so two different archetype branches whose own container happens
  // to share a technical name (e.g. two EVALUATION.clinical_synopsis
  // sections in one composed document) would collide the same way leaf
  // fields did. Kept as a separate counter/short-id scheme (no `${alias}_`
  // prefix) since containers never had one - only uniqueness changes here.
  const containerIdCounts: Record<string, number> = {};
  function getUniqueContainerId(nodeId: string): string {
    containerIdCounts[nodeId] = (containerIdCounts[nodeId] || 0) + 1;
    const count = containerIdCounts[nodeId];
    return count === 1 ? nodeId : `${nodeId}_${count}`;
  }

  // 2. Second, build the hierarchical layout tree
  function buildLayoutNode(node: any): FormElementLayout | null {
    if (!node) return null;

    if (isContextOrIgnoredNode(node)) {
      return null;
    }

    // Technical wrappers: collapse UNLESS they are repeatable
    // A repeatable technical wrapper (e.g. any_event max:-1) must stay visible
    // so the + button can attach to it
    if (isTechnicalWrapper(node)) {
      if (isRepeatable(node)) {
        // Treat as a visible container (like a cluster) — don't collapse
        const children = buildChildren(node);
        if (children.length === 0) return null;
        const repeat = getRepeatMeta(node);
        return {
          type: 'container',
          id: node.id ? getUniqueContainerId(node.id) : uuidv4(),
          label: node.name || node.id || 'Group',
          children: children,
          repeatMin: repeat.repeatMin,
          repeatMax: repeat.repeatMax,
          repeatable: repeat.repeatable,
          binding: containerBinding(node, alias, templateId)
        };
      }

      // Non-repeatable technical wrapper: collapse as before
      const children: FormElementLayout[] = [];
      if (node.children) {
        node.children.forEach((child: any) => {
          const parsedChild = buildLayoutNode(child);
          if (parsedChild) {
            if (parsedChild.type === 'technical-wrapper-collapsed') {
              if (parsedChild.children) {
                children.push(...parsedChild.children);
              }
            } else {
              children.push(parsedChild);
            }
          }
        });
      }
      return {
        type: 'technical-wrapper-collapsed',
        children: children
      };
    }

    if (isEntryNode(node)) {
      const children = buildChildren(node);
      if (children.length === 0) return null;
      const repeat = getRepeatMeta(node);
      const result: FormElementLayout = {
        type: 'container',
        id: node.id ? getUniqueContainerId(node.id) : uuidv4(),
        label: node.name || node.id || 'Section',
        children: children,
        binding: containerBinding(node, alias, templateId)
      };
      if (repeat.repeatable) {
        result.repeatMin = repeat.repeatMin;
        result.repeatMax = repeat.repeatMax;
        result.repeatable = true;
      }
      return result;
    }

    if (isClusterLikeNode(node)) {
      const children = buildChildren(node);
      if (children.length === 0) return null;
      const repeat = getRepeatMeta(node);
      
      // If it has exactly 1 child AND is NOT repeatable, collapse
      if (children.length === 1 && !repeat.repeatable) {
        return children[0];
      }

      const result: FormElementLayout = {
        type: 'container',
        id: node.id ? getUniqueContainerId(node.id) : uuidv4(),
        label: node.name || node.id || 'Group',
        children: children,
        binding: containerBinding(node, alias, templateId)
      };
      if (repeat.repeatable) {
        result.repeatMin = repeat.repeatMin;
        result.repeatMax = repeat.repeatMax;
        result.repeatable = true;
      }
      return result;
    }

    if (isElementNode(node)) {
      const fieldName = getUniqueFieldName(node.id);
      const matchedField = fields.find(f => f.fieldName === fieldName || (f.technicalName === node.id && f.openehrPath === node.aqlPath));
      if (!matchedField) return null;

      const inputType = getInputType(matchedField.dataType);

      // The short `id` must be disambiguated exactly like `fieldName` above -
      // otherwise two leaves from different archetype branches that happen
      // to share a technical name (e.g. two different archetypes both
      // having their own "comment" element, common once several components
      // are composed into one document - see compose_document_template)
      // collide on the SAME runtime values key. FormRuntime treats `id` as
      // the field's actual runtime identity whenever it differs from `name`
      // (see readFieldValue/nodeId), so an undeduplicated `id` here silently
      // merges two unrelated fields into one input - confirmed live while
      // building a composed multi-section document. Deriving it from the
      // already-deduplicated `fieldName` (stripping the shared `${alias}_`
      // prefix) keeps `id` and `name` consistent (e.g. "comment_2" /
      // "entlassbrief_comment_2") without a second, independent counter.
      const uniqueId = fieldName.startsWith(`${alias}_`) ? fieldName.slice(alias.length + 1) : fieldName;

      const repeat = getRepeatMeta(node);
      const layoutNode: FormElementLayout = {
        type: inputType,
        id: uniqueId || node.id || uuidv4(),
        name: matchedField.fieldName,
        label: node.name || node.id || '',
        required: node.min >= 1,
        // The leaf's binding, straight from its own FieldRegistryItem -
        // previously never set here at all, only in the separate top-level
        // `bindings` dict populated later by formGenerator.ts, which is
        // what caused the mismatched-key bug this epic fixes.
        binding: {
          templateAlias: matchedField.templateAlias,
          templateId: matchedField.templateId,
          rmType: matchedField.rmType,
          path: matchedField.openehrPath,
          ...(matchedField.flatPath ? { flatPath: matchedField.flatPath } : {}),
          ...(matchedField.archetypeNodeId ? { archetypeNodeId: matchedField.archetypeNodeId } : {}),
          ...(matchedField.archetypeId ? { archetypeId: matchedField.archetypeId } : {}),
          ...(matchedField.rmVersion ? { rmVersion: matchedField.rmVersion } : {}),
        }
      };

      if (repeat.repeatable) {
        layoutNode.repeatMin = repeat.repeatMin;
        layoutNode.repeatMax = repeat.repeatMax;
        layoutNode.repeatable = true;
      }

      if (inputType === 'input-quantity' && matchedField.constraints?.units) {
        layoutNode.unitOptions = matchedField.constraints.units.map(u => ({ unit: u }));
      }

      if (matchedField.options) {
        layoutNode.options = matchedField.options;
      }

      return layoutNode;
    }

    // Fallback wrapper node
    const children = buildChildren(node);
    if (children.length === 0) return null;
    const repeat = getRepeatMeta(node);
    const result: FormElementLayout = {
      type: 'container',
      id: node.id ? getUniqueContainerId(node.id) : uuidv4(),
      label: node.name || node.id || '',
      children: children,
      binding: containerBinding(node, alias, templateId)
    };
    if (repeat.repeatable) {
      result.repeatMin = repeat.repeatMin;
      result.repeatMax = repeat.repeatMax;
      result.repeatable = true;
    }
    return result;
  }

  function buildChildren(node: any): FormElementLayout[] {
    const children: FormElementLayout[] = [];
    if (node.children) {
      node.children.forEach((child: any) => {
        const parsedChild = buildLayoutNode(child);
        if (parsedChild) {
          if (parsedChild.type === 'technical-wrapper-collapsed') {
            if (parsedChild.children) {
              children.push(...parsedChild.children);
            }
          } else {
            children.push(parsedChild);
          }
        }
      });
    }
    return children;
  }

  let rootLayout: FormElementLayout | null = null;
  if (webTemplate.tree) {
    rootLayout = buildLayoutNode(webTemplate.tree);
  }

  const layoutChildren = rootLayout?.children || [];

  return {
    templateId,
    alias,
    fields,
    layout: {
      type: 'form',
      children: [
        {
          type: 'container',
          children: layoutChildren
        }
      ]
    }
  };
}
