import { AqlResponse } from '../types/aqlPrefill';

/**
 * Normalizes various EHRbase AQL response structures into an array of key-value row records.
 */
export function normalizeEhrbaseAqlResponse(response: unknown): Record<string, unknown>[] {
  if (response === undefined || response === null) {
    return [];
  }

  // Case 1: Direct array of row objects
  if (Array.isArray(response)) {
    return response.map((item) => {
      if (typeof item === 'object' && item !== null) {
        const rec = { ...(item as Record<string, unknown>) };
        if (rec.c && typeof rec.c === 'object' && rec.c !== null) {
          Object.assign(rec, rec.c);
        }
        return rec;
      }
      return { value: item };
    });
  }

  if (typeof response !== 'object') {
    return [{ value: response }];
  }

  const res = response as AqlResponse;

  // Case 2: Standard EHRbase AQL response with columns and rows
  if (Array.isArray(res.rows) && Array.isArray(res.columns)) {
    const columnNames = res.columns.map((col, idx) => col.name || col.path || `col_${idx}`);
    return res.rows.map((row) => {
      const record: Record<string, unknown> = {};
      if (Array.isArray(row)) {
        row.forEach((val, idx) => {
          const colName = columnNames[idx] || `col_${idx}`;
          record[colName] = val;
        });
      } else if (typeof row === 'object' && row !== null) {
        Object.assign(record, row);
      } else {
        record['value'] = row;
      }

      if (record.c && typeof record.c === 'object' && record.c !== null) {
        Object.assign(record, record.c);
      } else if (Array.isArray(row) && typeof row[0] === 'object' && row[0] !== null) {
        const comp = row[0] as Record<string, unknown>;
        if (comp._type === 'COMPOSITION' || comp.archetype_details || comp.content) {
          Object.assign(record, comp);
        }
      }

      return record;
    });
  }

  // Case 3: Result containing rows array without explicit columns definition
  if (Array.isArray(res.rows)) {
    return res.rows.map((row, idx) => {
      if (Array.isArray(row) && typeof row[0] === 'object' && row[0] !== null) {
        const comp = row[0] as Record<string, unknown>;
        if (comp._type === 'COMPOSITION' || comp.archetype_details || comp.content) {
          return { row, ...comp };
        }
      }
      if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
        return row as Record<string, unknown>;
      }
      return { [`row_${idx}`]: row };
    });
  }

  // Case 4: Result object with a data or result property
  if (Array.isArray(res.data)) {
    return normalizeEhrbaseAqlResponse(res.data);
  }
  if (Array.isArray(res.resultSet)) {
    return normalizeEhrbaseAqlResponse(res.resultSet);
  }

  // Case 5: Single result object
  const copy = { ...res };
  delete copy.meta;
  delete copy.q;
  if (copy.c && typeof copy.c === 'object' && copy.c !== null) {
    Object.assign(copy, copy.c);
  }
  return [copy as Record<string, unknown>];
}
