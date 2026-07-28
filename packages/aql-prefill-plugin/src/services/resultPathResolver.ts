function parseOpenEhrPathSegments(path: string): Array<{ propName: string; predicate?: string }> {
  const cleanPath = path.trim().replace(/^\//, '');
  const segments: Array<{ propName: string; predicate?: string }> = [];

  let i = 0;
  while (i < cleanPath.length) {
    let propName = '';
    while (i < cleanPath.length && cleanPath[i] !== '/' && cleanPath[i] !== '[') {
      propName += cleanPath[i];
      i++;
    }

    let predicate: string | undefined = undefined;
    if (i < cleanPath.length && cleanPath[i] === '[') {
      i++; // skip '['
      let predStr = '';
      let bracketDepth = 1;
      while (i < cleanPath.length && bracketDepth > 0) {
        if (cleanPath[i] === '[') bracketDepth++;
        else if (cleanPath[i] === ']') bracketDepth--;
        if (bracketDepth > 0) predStr += cleanPath[i];
        i++;
      }
      predicate = predStr.trim();
    }

    if (propName || predicate !== undefined) {
      segments.push({ propName, predicate });
    }

    if (i < cleanPath.length && cleanPath[i] === '/') {
      i++; // skip '/'
    }
  }

  return segments;
}

function matchesPredicate(item: unknown, predicate: string): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const obj = item as Record<string, unknown>;

  if (/^\d+$/.test(predicate)) {
    return true;
  }

  let nodeId = predicate;
  let nameValue: string | undefined = undefined;

  const andMatch = predicate.match(/^(.*?)\s+and\s+name\/value\s*=\s*['"](.*?)['"]$/i);
  if (andMatch) {
    nodeId = andMatch[1].trim();
    nameValue = andMatch[2];
  } else {
    const nameOnlyMatch = predicate.match(/^name\/value\s*=\s*['"](.*?)['"]$/i);
    if (nameOnlyMatch) {
      nodeId = '';
      nameValue = nameOnlyMatch[1];
    }
  }

  if (nodeId) {
    const itemNodeId = String(obj.archetype_node_id || '');
    const itemArchId = String((obj.archetype_details as any)?.archetype_id?.value || '');
    if (itemNodeId !== nodeId && itemArchId !== nodeId) {
      return false;
    }
  }

  if (nameValue !== undefined) {
    const itemName = typeof obj.name === 'string' ? obj.name : (obj.name as any)?.value;
    if (itemName !== nameValue) {
      return false;
    }
  }

  return true;
}

/**
 * Resolves property paths in nested JSON structures and openEHR compositions.
 * Supports dot notation, bracket indexing, and openEHR AQL archetype/name predicates.
 */
export function resolveResultPath(source: unknown, path: string): unknown {
  if (source === undefined || source === null || !path.trim()) {
    return undefined;
  }

  const segments = parseOpenEhrPathSegments(path);
  let current: unknown = source;

  for (const { propName, predicate } of segments) {
    if (current === undefined || current === null) return undefined;

    if (propName) {
      if (typeof current === 'object' && current !== null && propName in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[propName];
      } else if (Array.isArray(current)) {
        const idx = Number(propName);
        if (Number.isInteger(idx) && idx >= 0 && idx < current.length) {
          current = current[idx];
        } else {
          return undefined;
        }
      } else {
        return undefined;
      }
    }

    if (predicate !== undefined && current !== undefined && current !== null) {
      if (Array.isArray(current)) {
        if (/^\d+$/.test(predicate)) {
          const idx = Number(predicate);
          current = current[idx];
        } else {
          current = current.find((item) => matchesPredicate(item, predicate));
        }
      } else if (typeof current === 'object') {
        if (!matchesPredicate(current, predicate)) {
          current = undefined;
        }
      }
    }
  }

  if (typeof current === 'object' && current !== null) {
    const dvObj = current as Record<string, unknown>;
    if ('value' in dvObj && typeof dvObj.value === 'string') {
      return dvObj.value;
    }
    if ('value' in dvObj && typeof dvObj.value === 'number') {
      return dvObj.value;
    }
    if ('value' in dvObj && typeof dvObj.value === 'boolean') {
      return dvObj.value;
    }
    if (dvObj._type === 'DV_CODED_TEXT' && typeof dvObj.value === 'string') {
      return dvObj.value;
    }
    if (dvObj._type === 'CODE_PHRASE' && typeof dvObj.code_string === 'string') {
      return dvObj.code_string;
    }
  }

  return current;
}
