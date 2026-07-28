import { AqlParameterBinding, AqlPrefillConfiguration, PrefillRuntimeContext } from '../types/aqlPrefill';

/**
 * Builds the final AQL string based on configuration and queryMode.
 */
export function buildAqlQuery(config: AqlPrefillConfiguration, fallbackTemplateId?: string): string {
  const { queryMode, query, parameters = [] } = config;
  const timeColumn = query?.timeColumn || 'c/context/start_time/value';

  if (queryMode === 'custom' && query?.aql && query.aql.trim()) {
    return query.aql.trim();
  }

  let baseAql = (query?.aql || '').trim();
  const templateId = query?.templateId || fallbackTemplateId;

  if (!baseAql) {
    const ehrBinding = parameters.find((p) => p.source === 'ehrId' || p.queryParameter === '$ehrId' || p.queryParameter === 'ehrId');
    const compBinding = parameters.find((p) => p.source === 'compositionId' || p.queryParameter === '$compositionId' || p.queryParameter === 'compositionId');

    const hasEhrIdParam = Boolean(ehrBinding);
    const hasCompIdParam = Boolean(compBinding);

    const fromClause = hasEhrIdParam ? 'FROM EHR e CONTAINS COMPOSITION c' : 'FROM COMPOSITION c';
    const conditions: string[] = [];

    if (hasEhrIdParam) {
      const ehrParamName = ehrBinding?.queryParameter || '$ehrId';
      const formattedParam = ehrParamName.startsWith('$') ? ehrParamName : `$${ehrParamName}`;
      conditions.push(`e/ehr_id/value = ${formattedParam}`);
    }

    if (hasCompIdParam) {
      const compParamName = compBinding?.queryParameter || '$compositionId';
      const formattedParam = compParamName.startsWith('$') ? compParamName : `$${compParamName}`;
      conditions.push(`c/uid/value = ${formattedParam}`);
    }

    if (templateId) {
      conditions.push(`c/archetype_details/template_id/value = '${templateId}'`);
    } else if (query?.archetypeId) {
      conditions.push(`c/archetype_details/archetype_id/value = '${query.archetypeId}'`);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const selectClause = (queryMode === 'latest' || queryMode === 'earliest')
      ? `SELECT c, ${timeColumn} AS start_time`
      : 'SELECT c';
    baseAql = `${selectClause} ${fromClause}${whereClause}`;
  } else {
    if (templateId && !baseAql.includes('template_id')) {
      if (/\bWHERE\b/i.test(baseAql)) {
        baseAql = baseAql.replace(/\bWHERE\b/i, `WHERE c/archetype_details/template_id/value = '${templateId}' AND `);
      } else {
        baseAql = `${baseAql} WHERE c/archetype_details/template_id/value = '${templateId}'`;
      }
    }
    if ((queryMode === 'latest' || queryMode === 'earliest') && !baseAql.includes(timeColumn) && !baseAql.includes('start_time')) {
      if (/^SELECT\s+c\s+/i.test(baseAql)) {
        baseAql = baseAql.replace(/^SELECT\s+c\s+/i, `SELECT c, ${timeColumn} AS start_time `);
      }
    }
  }

  const cleanAql = baseAql.replace(/\s+ORDER\s+BY\s+[\s\S]+/i, '').replace(/\s+LIMIT\s+\d+/i, '').trim();

  if (queryMode === 'latest') {
    return `${cleanAql} ORDER BY ${timeColumn} DESC LIMIT 1`;
  }

  if (queryMode === 'earliest') {
    return `${cleanAql} ORDER BY ${timeColumn} ASC LIMIT 1`;
  }

  return cleanAql;
}

/**
 * Resolves configuration parameter bindings into a key-value map for query execution.
 */
export function resolveAqlParameters(
  bindings: AqlParameterBinding[],
  context: PrefillRuntimeContext
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const binding of bindings) {
    const { queryParameter, source, fieldId, staticValue } = binding;
    if (!queryParameter) continue;

    const paramName = queryParameter.replace(/^\$/, '');

    switch (source) {
      case 'ehrId':
        resolved[paramName] = context.ehrId || context.patientId || '';
        break;
      case 'patientId':
        resolved[paramName] = context.patientId || context.ehrId || '';
        break;
      case 'encounterId':
        resolved[paramName] = context.encounterId ?? '';
        break;
      case 'compositionId':
        resolved[paramName] = context.compositionId ?? '';
        break;
      case 'formField':
        resolved[paramName] = fieldId && context.formValues ? context.formValues[fieldId] : undefined;
        break;
      case 'static':
        resolved[paramName] = staticValue;
        break;
      default:
        resolved[paramName] = undefined;
    }
  }

  return resolved;
}
