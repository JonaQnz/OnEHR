/**
 * Resolves a single value out of an AQL result row (or any nested JSON),
 * using openEHR-flavored paths: dot/slash-separated property names, plain
 * array indices (`items[2]`), and openEHR archetype/name predicates
 * (`items[at0006]`, `items[at0006 and name/value='Systolic']`). This is
 * the piece the old `formbuilder-plugin-aql-prefill` package's
 * `resultPathResolver.ts` implemented (correctly - the logic below is a
 * faithful port, not a rewrite) but never shipped a single test for; see
 * `docs/features/aql-prefill.md` for the feature this now powers as core,
 * non-plugin code (`beforeLoad` Form Script prefilling via `field.prefill()`).
 *
 * Kept deliberately dependency-free and pure so it can run identically in
 * the Form Script web worker (`apps/web/src/scripting/runtime/formScript.worker.ts`)
 * and, if a caller ever needs it, server-side in apps/api - one
 * implementation, not two copies drifting apart.
 */

interface PathSegment {
  propName: string;
  predicate?: string;
}

function parseAqlResultPathSegments(path: string): PathSegment[] {
  const cleanPath = path.trim().replace(/^\//, '');
  const segments: PathSegment[] = [];

  let i = 0;
  while (i < cleanPath.length) {
    let propName = '';
    while (i < cleanPath.length && cleanPath[i] !== '/' && cleanPath[i] !== '[') {
      propName += cleanPath[i];
      i++;
    }

    let predicate: string | undefined;
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
      segments.push(predicate !== undefined ? { propName, predicate } : { propName });
    }

    if (i < cleanPath.length && cleanPath[i] === '/') {
      i++; // skip '/'
    }
  }

  return segments;
}

function matchesAqlPredicate(item: unknown, predicate: string): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const obj = item as Record<string, unknown>;

  // A bare integer predicate ("items[2]") is an array-index selector,
  // handled by the caller before this function is reached for arrays -
  // for a single object it's meaningless, so treat it as "matches
  // anything" rather than failing the whole path.
  if (/^\d+$/.test(predicate)) {
    return true;
  }

  let nodeId = predicate;
  let nameValue: string | undefined;

  const andMatch = predicate.match(/^(.*?)\s+and\s+name\/value\s*=\s*['"](.*?)['"]$/i);
  if (andMatch) {
    nodeId = (andMatch[1] ?? '').trim();
    nameValue = andMatch[2] ?? '';
  } else {
    const nameOnlyMatch = predicate.match(/^name\/value\s*=\s*['"](.*?)['"]$/i);
    if (nameOnlyMatch) {
      nodeId = '';
      nameValue = nameOnlyMatch[1] ?? '';
    }
  }

  if (nodeId) {
    const itemNodeId = String(obj.archetype_node_id || '');
    const itemArchId = String((obj.archetype_details as { archetype_id?: { value?: string } } | undefined)?.archetype_id?.value || '');
    if (itemNodeId !== nodeId && itemArchId !== nodeId) {
      return false;
    }
  }

  if (nameValue !== undefined) {
    const itemName = typeof obj.name === 'string' ? obj.name : (obj.name as { value?: string } | undefined)?.value;
    if (itemName !== nameValue) {
      return false;
    }
  }

  return true;
}

/**
 * Resolves an openEHR-flavored path against an AQL result row (or any
 * nested JSON structure). Supports plain property access, array
 * indexing, and archetype-node-id / `name/value=` predicates. Once the
 * path is fully walked, a terminal openEHR data value (anything with a
 * primitive `.value`, a `DV_CODED_TEXT`, or a `CODE_PHRASE`) is unwrapped
 * to its plain value automatically - the caller gets a usable string/
 * number/boolean, not an RM envelope.
 */
export function resolveAqlResultPath(source: unknown, path: string): unknown {
  if (source === undefined || source === null || !path.trim()) {
    return undefined;
  }

  const segments = parseAqlResultPathSegments(path);
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
          current = current.find((item) => matchesAqlPredicate(item, predicate));
        }
      } else if (typeof current === 'object') {
        if (!matchesAqlPredicate(current, predicate)) {
          current = undefined;
        }
      }
    }
  }

  if (typeof current === 'object' && current !== null) {
    const dvObj = current as Record<string, unknown>;
    if ('value' in dvObj && (typeof dvObj.value === 'string' || typeof dvObj.value === 'number' || typeof dvObj.value === 'boolean')) {
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
