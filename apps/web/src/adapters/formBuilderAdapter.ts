import { CanonicalForm, FormElementLayout } from 'core';

export function getElementText(element: string, label: string): string {
  if (!label) return element;
  // If the label already starts with Type: prefix, return it as is
  if (/^(Group|Text|Number|Select|Date|Checkbox|Radio|Textarea|Paragraph|Header|Layout|Divider|Button):\s*(.*)$/.test(label)) {
    return label;
  }
  if (element === 'FieldSet') return `Group: ${label}`;
  if (element === 'TextInput') return `Text: ${label}`;
  if (element === 'NumberInput') return `Number: ${label}`;
  if (element === 'Dropdown') return `Select: ${label}`;
  if (element === 'DatePicker') return `Date: ${label}`;
  if (element === 'Checkboxes') return `Checkbox: ${label}`;
  if (element === 'RadioButtons') return `Radio: ${label}`;
  if (element === 'TextArea') return `Textarea: ${label}`;
  if (element === 'Paragraph') return `Paragraph: ${label}`;
  if (element === 'Header') return `Header: ${label}`;
  if (element === 'LineBreak') return `Divider Line`;
  if (element === 'Button') return `Button: ${label}`;
  if (element === 'TwoColumnRow') return `Layout: 2 Columns`;
  if (element === 'ThreeColumnRow') return `Layout: 3 Columns`;
  if (element === 'MultiColumnRow') return `Layout: Multi Columns`;
  return `${element}: ${label}`;
}

export function cleanLabel(text: string): string {
  if (!text) return '';
  const match = text.match(/^(Group|Text|Number|Select|Date|Checkbox|Radio|Textarea|Paragraph|Header|Layout|Divider|Button):\s*(.*)$/);
  return match ? match[2] : text;
}

/**
 * Older saved forms stored plugin fields with their plugin key as `element`
 * (for example `IframeField`). react-form-builder2 only renders plugin fields
 * through `CustomElement` and resolves the component from `key`. Normalize at
 * the UI boundary so opening an old form also migrates it on its next save.
 */
export function hydrateCustomBuilderElements(
  items: any[],
  customFields: ReadonlyArray<{ key: string; component: unknown }>,
): any[] {
  if (!Array.isArray(items)) return items;
  const fieldsByKey = new Map(customFields.map((field) => [field.key, field]));
  const builtInElements = new Set([
    'TextInput', 'NumberInput', 'TextArea', 'Dropdown', 'Checkboxes',
    'RadioButtons', 'DatePicker', 'Signature', 'Paragraph', 'Header',
    'Label', 'LineBreak', 'HyperLink', 'Button', 'Rating', 'Tags', 'Range',
    'Camera', 'FileUpload', 'FieldSet', 'TwoColumnRow', 'ThreeColumnRow',
    'MultiColumnRow', 'CustomElement',
  ]);

  return items.map((item) => {
    const registeredKey = [item?.key, item?.element, item?.custom_metadata?.type]
      .find((candidate) => typeof candidate === 'string' && fieldsByKey.has(candidate));
    const legacyCustomKey = typeof item?.element === 'string' && !builtInElements.has(item.element)
      ? item.element
      : undefined;
    const key = registeredKey || legacyCustomKey;
    if (!key) return item;
    const field = fieldsByKey.get(key);

    return {
      ...item,
      element: 'CustomElement',
      key,
      ...(field ? { component: field.component } : {}),
      type: 'custom',
      custom: true,
      forwardRef: item.forwardRef ?? true,
      custom_metadata: {
        ...(item.custom_metadata || {}),
        type: key,
      },
    };
  });
}

export function canonicalToFormBuilder(form: CanonicalForm): any[] {
  const items: any[] = [];
  let generatedIdSequence = 0;
  const generatedId = (kind: string, parentId?: string, colIdx?: number) => {
    generatedIdSequence++;
    const randomSuffix = Math.random().toString(36).substr(2, 4);
    if (parentId && colIdx !== undefined) {
      return `${parentId}_col${colIdx}_${kind}_${generatedIdSequence}_${randomSuffix}`;
    }
    return `${kind}_gen_${generatedIdSequence}_${randomSuffix}`;
  };

  // Helper to map a layoutNode back to a Form Builder element
  function mapLayoutNodeToItem(node: FormElementLayout, parentId?: string, colIdx?: number): any {
    const fieldName = node.name || 'field';
    const labelSelector = `[name='${fieldName}']`;
    const label = form.locales?.en?.[labelSelector]?.label || node.label || fieldName;
    const binding = form.bindings?.[fieldName]?.openehr || node.binding;

    let element = node.uiElement;
    if (!element) {
      if (node.type === 'button') {
        element = 'HyperLink';
      } else if (node.type === 'input-quantity' || node.type === 'input-proportion' || node.type === 'input-number') {
        element = 'NumberInput';
      } else if (node.type === 'input-date' || node.type === 'input-date-time' || node.type === 'input-time') {
        element = 'DatePicker';
      } else if (node.type === 'input-select' || node.type === 'input-boolean' || node.type === 'input-ordinal') {
        element = 'Dropdown';
      } else {
        element = 'TextInput';
      }
    }

    const needsOptions = ['Dropdown', 'Checkboxes', 'RadioButtons', 'Tags'].includes(element);
    const isNumberOrRange = ['NumberInput', 'Range', 'Rating'].includes(element);

    const item: any = {
      id: node.id || fieldName,
      element: element,
      text: getElementText(element, label),
      label: label,
      field_name: fieldName,
      canHaveAnswer: node.type !== 'button',
      canReadOnly: true,
      canHavePageBreakBefore: true,
      canHaveAlternateForm: true,
      canHaveDisplayHorizontal: true,
      canHaveOptionCorrect: false,
      canHaveOptionValue: true,
      canPopulateFromApi: needsOptions,
      placeholder: node.placeholder || '',
      description: node.description || '',
      required: node.required ?? false,
      readOnly: node.readOnly || false,
      // Round-trips through the builder's own "Hidden by default" checkbox
      // (react-form-builder2 reads/writes `element.hidden` directly - see
      // form-elements-edit.jsx). Distinct from alwaysHidden's canonical name
      // only because that's what the vendored library already calls it.
      hidden: node.alwaysHidden === true,
      custom_metadata: {
        type: node.type,
        binding: binding,
        unitOptions: (node.unitOptions && node.unitOptions.length > 0)
          ? node.unitOptions
          : ((node as any).unitoptions && (node as any).unitoptions.length > 0)
            ? (node as any).unitoptions
            : (binding?.rmType === 'DV_QUANTITY' || node.type === 'input-quantity' ? [{ unit: 'cm' }] : undefined),
        repeatMin: node.repeatMin,
        repeatMax: node.repeatMax,
        repeatable: node.repeatable || false
      }
    };

    if (parentId !== undefined) {
      item.parentId = parentId;
    }
    if (colIdx !== undefined) {
      item.col = colIdx;
    }

    if (node.options) {
      item.options = node.options.map((opt: any, index: number) => ({
        ...opt,
        key: opt.key || `${node.id || fieldName}_option_${index}`
      }));
    } else if (needsOptions) {
      // Dropdown/Checkboxes/RadioButtons/Tags all iterate element.options
      // unconditionally in react-form-builder2's own renderers - leaving it
      // undefined (e.g. an input-boolean or input-ordinal field whose
      // parsed WebTemplate never produced an options list) crashes the
      // canvas outright instead of just rendering an empty choice list.
      item.options = [];
    }

    if (node.showTimeSelect !== undefined) {
      item.showTimeSelect = node.showTimeSelect;
    } else {
      item.showTimeSelect = binding?.rmType === 'DV_DATE_TIME' || binding?.rmType === 'DV_TIME';
    }

    if (node.showTimeSelectOnly !== undefined) {
      item.showTimeSelectOnly = node.showTimeSelectOnly;
    } else {
      item.showTimeSelectOnly = binding?.rmType === 'DV_TIME';
    }

    if (element === 'DatePicker') {
      item.dateFormat = node.dateFormat || 'dd.MM.yyyy';
      item.timeFormat = node.timeFormat || 'HH:mm';
    }

    item.step = node.step ?? (isNumberOrRange ? 1 : undefined);
    item.min_value = node.min_value ?? (isNumberOrRange ? 0 : undefined);
    item.max_value = node.max_value ?? (isNumberOrRange ? 100 : undefined);
    item.default_value = node.default_value ?? (isNumberOrRange ? 0 : undefined);

    if (node.props) {
      item.props = node.props;
      if (node.props.hideDefaultProperties) {
        item.hideDefaultProperties = true;
      }
    }

    if (element === 'CustomElement') {
      item.custom = true;
      item.key = node.type;
    }

    return item;
  }

  // Recursive traversal of layout tree
  function traverseLayout(node: FormElementLayout, parentId?: string, colIdx?: number): string | undefined {
    if (!node) return undefined;

    if (node.type === 'form') {
      if (node.children) {
        node.children.forEach(child => {
          if (child.type === 'container' && child.children) {
            child.children.forEach(subChild => traverseLayout(subChild, parentId, undefined));
          } else {
            traverseLayout(child, parentId, undefined);
          }
        });
      }
      return undefined;
    }

    if (node.type === 'container') {
      const containerId = node.id || generatedId('container', parentId, colIdx);
      const containerItem: any = {
        id: containerId,
        element: 'FieldSet',
        text: getElementText('FieldSet', node.label || 'Group Container'),
        label: node.label || 'Group Container',
        isContainer: true,
        field_name: node.id || 'group_container',
        custom_metadata: {
          technicalName: node.id || 'group_container',
          repeatMin: node.repeatMin,
          repeatMax: node.repeatMax,
          repeatable: node.repeatable || false,
          collapsible: (node as any).collapsible,
          initiallyCollapsed: (node as any).initiallyCollapsed
        }
      };
      if (parentId) {
        containerItem.parentId = parentId;
      }
      if (colIdx !== undefined) {
        containerItem.col = colIdx;
      }
      items.push(containerItem);

      if (node.children) {
        node.children.forEach((child, index) => traverseLayout(child, containerId, index));
      }
      return containerId;
    }

    if (node.type === 'row') {
      const isContainerRow = node.uiElement === 'TwoColumnRow' || 
                             node.uiElement === 'ThreeColumnRow' || 
                             node.uiElement === 'MultiColumnRow' ||
                             (node.children && node.children.length > 1);

      if (isContainerRow) {
        const rowId = node.id || generatedId('row', parentId, colIdx);
        const colCount = node.children ? node.children.length : 2;
        const rowElement = node.uiElement || (colCount === 2 ? 'TwoColumnRow' : (colCount === 3 ? 'ThreeColumnRow' : 'MultiColumnRow'));

        const colSpans: any[] = [];
        if (node.children) {
          node.children.forEach((colNode) => {
            if (colNode.type === 'column') {
              colSpans.push({
                spanlarge: colNode.spanLarge,
                spanmedium: colNode.spanMedium,
                spansmall: colNode.spanSmall
              });
            }
          });
        }

        const rowItem: any = {
          id: rowId,
          element: rowElement,
          text: getElementText(rowElement, node.label || ''),
          childItems: Array(colCount).fill(null),
          isContainer: true,
          custom_metadata: {
            gap: (node as any).gap,
            colSpans: colSpans.length > 0 ? colSpans : undefined
          }
        };
        if (parentId) {
          rowItem.parentId = parentId;
        }
        if (colIdx !== undefined) {
          rowItem.col = colIdx;
        }

        if (node.children) {
          node.children.forEach((colNode, c) => {
            if (colNode.children) {
              colNode.children.forEach(child => {
                const childId = traverseLayout(child, rowId, c);
                if (childId) {
                  rowItem.childItems[c] = childId;
                }
              });
            }
          });
        }

        items.push(rowItem);
        return rowId;
      } else {
        if (node.children) {
          node.children.forEach(child => traverseLayout(child, parentId, colIdx));
        }
        return undefined;
      }
    }

    if (node.type === 'column') {
      if (node.children) {
        node.children.forEach(child => traverseLayout(child, parentId, colIdx));
      }
      return undefined;
    }

    // Static text elements
    if (node.type === 'header' || node.type === 'paragraph' || node.type === 'line-break') {
      const element = node.type === 'header' ? 'Header' :
                      node.type === 'paragraph' ? 'Paragraph' : 'LineBreak';
      const staticId = node.id || generatedId('static', parentId, colIdx);
      const staticItem: any = {
        id: staticId,
        element: element,
        text: getElementText(element, node.content || ''),
        content: node.content || '',
        static: true
      };
      if (parentId) {
        staticItem.parentId = parentId;
      }
      if (colIdx !== undefined) {
        staticItem.col = colIdx;
      }
      items.push(staticItem);
      return staticId;
    }

    // Standard leaf input element
    const leafId = node.id || node.name || generatedId('field', parentId, colIdx);
    const leafItem = mapLayoutNodeToItem({ ...node, id: leafId }, parentId, colIdx);
    items.push(leafItem);
    return leafId;
  }

  traverseLayout(form.layout);

  const byId = new Map(items.map(item => [item.id, item]));
  const hasCyclicParent = (item: any) => {
    const seen = new Set<string>([item.id]);
    let parentId = item.parentId;
    while (parentId) {
      if (seen.has(parentId)) return true;
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };

  items.forEach(item => {
    if (item.parentId && (!byId.has(item.parentId) || hasCyclicParent(item))) {
      delete item.parentId;
      delete item.col;
    }
  });

  items.filter(item => item.element === 'FieldSet').forEach(container => {
    const childrenIds = items
      .filter(child => child.parentId === container.id)
      .sort((a, b) => (a.col ?? 0) - (b.col ?? 0))
      .map(child => child.id);
    container.childItems = [...childrenIds, null];
  });

  return items;
}


export function formBuilderToCanonical(items: any[], originalForm: CanonicalForm): CanonicalForm {
  // Map an item (flat React Form Builder element) to a layout element.
  function mapLeafItemToLayoutNode(item: any): FormElementLayout {
    const meta = item.custom_metadata || {};
    const fieldName = item.field_name || `field_${item.id}`;
    const binding = meta.binding || {};
    const archetypeNodeId = binding.path?.match(/\[(at\d+)\]/)?.[1] || '';

    let type = meta.type || 'input-text';
    if (meta.type === 'button' || item.element === 'Button') {
      type = 'button';
    } else if (['Dropdown', 'Checkboxes', 'RadioButtons', 'Tags'].includes(item.element)) {
      type = 'input-select';
    } else if (['NumberInput', 'Range', 'Rating'].includes(item.element)) {
      type = meta.type?.includes('proportion') ? 'input-proportion' : 'input-quantity';
    } else if (item.element === 'DatePicker') {
      type = item.showTimeSelectOnly ? 'input-time' : (item.showTimeSelect ? 'input-date-time' : 'input-date');
    } else if (['TextInput', 'TextArea'].includes(item.element)) {
      type = 'input-text';
    }

    const layoutNode: FormElementLayout = {
      type: type,
      name: fieldName,
      uiElement: item.element,
      required: item.required ?? false,
      readOnly: item.readOnly || false,
      id: item.id,
      label: item.label || item.text || '',
      content: meta.type === 'button' || item.element === 'Button' ? (item.label || item.text || 'Aktion') : undefined,
      description: item.description || '',
      helpText: item.description || '',
      placeholder: item.placeholder || '',
      dateFormat: item.element === 'DatePicker' ? (item.dateFormat || 'dd.MM.yyyy') : undefined,
      timeFormat: item.element === 'DatePicker' ? (item.timeFormat || 'HH:mm') : undefined,
      defaultValue: item.defaultValue ?? item.default_value,
      semanticType: binding.rmType || '',
      unit: (meta.unitOptions && meta.unitOptions[0]) ? (typeof meta.unitOptions[0] === 'string' ? meta.unitOptions[0] : meta.unitOptions[0].unit) : '',
      archetypeNodeId: archetypeNodeId,
      binding: binding.path ? binding : undefined,
      validation: {
        min: item.min_value,
        max: item.max_value,
        regex: item.regex
      }
    };

    if (meta.unitOptions) {
      layoutNode.unitOptions = meta.unitOptions;
    }
    if (item.options) {
      layoutNode.options = item.options.map((opt: any, index: number) => ({
        value: opt.value,
        text: opt.text,
        key: opt.key || `${item.id}_option_${index}`
      }));
    }
    if (item.showTimeSelect !== undefined) {
      layoutNode.showTimeSelect = item.showTimeSelect;
    }
    if (item.showTimeSelectOnly !== undefined) {
      layoutNode.showTimeSelectOnly = item.showTimeSelectOnly;
    }
    if (['NumberInput', 'Range', 'Rating'].includes(item.element)) {
      if (item.step !== undefined) layoutNode.step = item.step;
      if (item.min_value !== undefined) layoutNode.min_value = item.min_value;
      if (item.max_value !== undefined) layoutNode.max_value = item.max_value;
      if (item.default_value !== undefined) layoutNode.default_value = item.default_value;
    }

    if (meta.repeatable) {
      layoutNode.repeatMin = meta.repeatMin;
      layoutNode.repeatMax = meta.repeatMax;
      layoutNode.repeatable = true;
    }

    if (item.props || item.hideDefaultProperties) {
      layoutNode.props = { ...(item.props || {}) };
      if (item.hideDefaultProperties) {
        layoutNode.props!.hideDefaultProperties = true;
      }
    }

    if (item.hidden === true) {
      layoutNode.alwaysHidden = true;
    }

    return layoutNode;
  }

  function mapItemOrRowToLayoutNode(item: any, ancestors: Set<string> = new Set()): FormElementLayout {
    const itemId = String(item?.id || 'unknown');
    if (ancestors.has(itemId)) {
      console.warn('Ignoring cyclic form-builder parent relation for', itemId);
      return { type: 'container', id: itemId, label: item?.label || cleanLabel(item?.text) || 'Group', children: [] };
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(itemId);
    if (item.element === 'FieldSet') {
      const children = items
        .filter(child => child.parentId === item.id)
        .sort((a, b) => (a.col ?? 0) - (b.col ?? 0))
        .map(child => mapItemOrRowToLayoutNode(child, nextAncestors));
      const meta = item.custom_metadata || {};
      const result: FormElementLayout = {
        type: 'container',
        id: item.id,
        label: item.label || cleanLabel(item.text) || '',
        children: children
      };
      if (meta.repeatable) {
        result.repeatMin = meta.repeatMin;
        result.repeatMax = meta.repeatMax;
        result.repeatable = true;
      }
      if (meta.collapsible !== undefined) {
        (result as any).collapsible = meta.collapsible;
      }
      if (meta.initiallyCollapsed !== undefined) {
        (result as any).initiallyCollapsed = meta.initiallyCollapsed;
      }
      return result;
    }

    const isTwoCol = item.element === 'TwoColumnRow';
    const isThreeCol = item.element === 'ThreeColumnRow';
    const isMultiCol = item.element === 'MultiColumnRow';

    if (isTwoCol || isThreeCol || isMultiCol) {
      const colCount = isTwoCol ? 2 : (isThreeCol ? 3 : (item.col_count || 4));
      const meta = item.custom_metadata || {};
      const colSpans = meta.colSpans || [];

      const columns: FormElementLayout[] = [];
      for (let c = 0; c < colCount; c++) {
        const columnItems = items.filter(child => child.parentId === item.id && child.col === c);
        
        const defaultSpan = 12 / colCount;
        const colSpanConfig = colSpans[c] || {
          spanlarge: defaultSpan,
          spanmedium: defaultSpan,
          spansmall: 12
        };

        columns.push({
          type: 'column',
          spanLarge: colSpanConfig.spanlarge ?? colSpanConfig.spanLarge ?? defaultSpan,
          spanMedium: colSpanConfig.spanmedium ?? colSpanConfig.spanMedium ?? defaultSpan,
          spanSmall: colSpanConfig.spansmall ?? colSpanConfig.spanSmall ?? 12,
          children: columnItems.map(child => mapItemOrRowToLayoutNode(child, nextAncestors))
        });
      }

      const rowNode: FormElementLayout = {
        type: 'row',
        uiElement: item.element,
        id: item.id,
        label: item.label || item.text || '',
        children: columns
      };

      if (meta.gap !== undefined) {
        (rowNode as any).gap = meta.gap;
      }

      return rowNode;
    }

    if (item.element === 'Header') {
      return {
        type: 'row',
        children: [{
          type: 'column',
          spanLarge: 12,
          spanMedium: 12,
          spanSmall: 12,
          children: [{ type: 'header', content: item.content || 'Header Text', id: item.id }]
        }]
      };
    }

    if (item.element === 'Paragraph') {
      return {
        type: 'row',
        children: [{
          type: 'column',
          spanLarge: 12,
          spanMedium: 12,
          spanSmall: 12,
          children: [{ type: 'paragraph', content: item.content || 'Paragraph text...', id: item.id }]
        }]
      };
    }

    if (item.element === 'LineBreak') {
      return {
        type: 'row',
        children: [{
          type: 'column',
          spanLarge: 12,
          spanMedium: 12,
          spanSmall: 12,
          children: [{ type: 'line-break', id: item.id }]
        }]
      };
    }

    return mapLeafItemToLayoutNode(item);
  }

  const rootLayoutNodes: FormElementLayout[] = items
    .filter(item => !item.parentId)
    .map(child => mapItemOrRowToLayoutNode(child));

  const layout: FormElementLayout = {
    type: 'form',
    children: [
      {
        type: 'container',
        children: rootLayoutNodes
      }
    ]
  };

  const bindings: Record<string, any> = {};
  const localesEn: Record<string, any> = {};

  if (originalForm.locales?.en) {
    Object.keys(originalForm.locales.en).forEach(key => {
      if (!key.startsWith("[name='")) {
        localesEn[key] = originalForm.locales.en[key];
      }
    });
  }

  items.forEach(item => {
    const fieldName = item.field_name;
    if (!fieldName) return;
    const meta = item.custom_metadata || {};

    if (meta.binding) {
      bindings[fieldName] = {
        openehr: meta.binding
      };
    }


    localesEn[`[name='${fieldName}']`] = {
      label: item.label || cleanLabel(item.text) || fieldName
    };
  });

  return {
    ...originalForm,
    layout,
    bindings,
    locales: {
      ...originalForm.locales,
      en: localesEn
    }
  };
}
