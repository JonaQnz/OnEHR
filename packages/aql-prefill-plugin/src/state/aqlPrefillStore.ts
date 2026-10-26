import {
  AqlPrefillCacheEntry,
  AqlPrefillConfiguration,
  PrefillFieldState,
  PrefillProvenance,
  PrefillRuntimeContext,
  PrefillValue,
} from '../types/aqlPrefill';
import { resolveResultPath } from '../services/resultPathResolver';
import { normalizeEhrbaseAqlResponse } from '../services/ehrbaseAqlAdapter';
import { AqlClient } from '../services/aqlClient';
import { buildAqlQuery, resolveAqlParameters } from '../utils/queryBuilder';
import { buildContextKey } from '../utils/contextKey';
import { aqlPrefillCache } from './aqlPrefillCache';

export interface ApplyPrefillResult {
  updatedValues: Record<string, unknown>;
  updatedStates: Record<string, PrefillFieldState>;
  provenanceList: PrefillProvenance[];
  conflicts?: Array<{
    fieldId: string;
    currentValue: unknown;
    prefillValue: unknown;
  }>;
  success: boolean;
  message?: string;
}

export interface LoadPrefillResult {
  cacheEntry: AqlPrefillCacheEntry;
  applied: boolean;
  applyResult?: ApplyPrefillResult;
}

/**
 * Loads AQL prefill data from EHRbase via AQL query, normalizes results, and caches them in session memory.
 * Does not mutate form values unless config.executionMode === 'automatic'.
 */
export async function loadAqlPrefillData(
  config: AqlPrefillConfiguration,
  context: PrefillRuntimeContext,
  options: {
    client?: AqlClient;
    forceRefresh?: boolean;
    currentValues?: Record<string, unknown>;
    fieldStates?: Record<string, PrefillFieldState>;
  } = {}
): Promise<LoadPrefillResult> {
  const parameters = resolveAqlParameters(config.parameters || [], context);
  const contextKey = buildContextKey(config.id, context, parameters);

  if (options.forceRefresh) {
    aqlPrefillCache.invalidate(contextKey);
  }

  let cacheEntry = aqlPrefillCache.get(contextKey);

  if (!cacheEntry) {
    const aqlQuery = buildAqlQuery(config, context.templateId as string | undefined);
    const client = options.client || new AqlClient();
    const rawResult = await client.executeQuery({ query: aqlQuery, parameters });

    const normalizedRows = normalizeEhrbaseAqlResponse(rawResult);
    const firstRow = normalizedRows[0] || {};

    const effectiveMappings = [...(config.mappings || [])];
    if (context.formFields && Array.isArray(context.formFields)) {
      for (const field of context.formFields) {
        const path = field.aqlPath || (field.id && field.id.startsWith('/') ? field.id : undefined);
        if (path && !effectiveMappings.some((m) => m.target?.fieldId === field.id)) {
          effectiveMappings.push({
            id: `auto_${field.id}`,
            resultPath: path,
            target: { fieldId: field.id },
          });
        }
      }
    }

    const normalizedValues: Record<string, PrefillValue> = {};

    for (const mapping of effectiveMappings) {
      let value = resolveResultPath(firstRow, mapping.resultPath);
      let unit = mapping.metadata?.unitPath
        ? (resolveResultPath(firstRow, mapping.metadata.unitPath) as string)
        : undefined;

      if (value && typeof value === 'object' && !Array.isArray(value) && (value as any)['_type']) {
        const rmType = (value as any)['_type'];
        if (['DV_TEXT', 'DV_CODED_TEXT', 'DV_DATE_TIME', 'DV_DATE', 'DV_TIME', 'DV_BOOLEAN', 'DV_IDENTIFIER'].includes(rmType)) {
          value = (value as any)['value'] ?? value;
        } else if (rmType === 'DV_QUANTITY') {
          if (!unit && (value as any)['units']) {
            unit = (value as any)['units'];
          }
          value = (value as any)['magnitude'] ?? value;
        } else if (rmType === 'DV_PROPORTION') {
          value = (value as any)['numerator'] ?? value;
        } else if (rmType === 'DV_COUNT') {
          value = (value as any)['magnitude'] ?? value;
        } else if (rmType === 'DV_ORDINAL') {
          value = (value as any)['symbol']?.['value'] ?? (value as any)['value'] ?? value;
        }
      }

      const timestamp = mapping.metadata?.timestampPath
        ? (resolveResultPath(firstRow, mapping.metadata.timestampPath) as string)
        : undefined;
      const source = mapping.metadata?.sourcePath
        ? (resolveResultPath(firstRow, mapping.metadata.sourcePath) as string)
        : undefined;

      const available = value !== undefined && value !== null && value !== '';

      normalizedValues[mapping.id] = {
        value,
        unit,
        timestamp,
        source,
        available,
      };
    }

    cacheEntry = {
      configurationId: config.id,
      contextKey,
      loadedAt: new Date().toISOString(),
      rawResult,
      normalizedValues,
    };

    aqlPrefillCache.set(cacheEntry);
  }

  let applied = false;
  let applyResult: ApplyPrefillResult | undefined = undefined;

  // Auto-apply if executionMode is 'automatic'
  if (config.executionMode === 'automatic' && options.currentValues) {
    applyResult = applyPrefillForm(config, cacheEntry, options.currentValues, options.fieldStates || {});
    applied = applyResult.success;
  }

  return {
    cacheEntry,
    applied,
    applyResult,
  };
}

/**
 * Normalizes field state for tracking overwrite status
 */
export function getOrCreateFieldState(
  fieldId: string,
  currentValue: unknown,
  existingStates: Record<string, PrefillFieldState> = {}
): PrefillFieldState {
  if (existingStates[fieldId]) {
    return existingStates[fieldId];
  }

  const isEmpty = currentValue === undefined || currentValue === null || currentValue === '';
  return {
    fieldId,
    value: currentValue,
    source: isEmpty ? 'empty' : 'user',
    dirty: !isEmpty,
  };
}

/**
 * Helper to apply mapped values for a given subset of mappings with overwrite conflict detection.
 */
function applyMappedValues(
  config: AqlPrefillConfiguration,
  cacheEntry: AqlPrefillCacheEntry,
  mappings: typeof config.mappings,
  currentValues: Record<string, unknown>,
  fieldStates: Record<string, PrefillFieldState>,
  options: { forceOverwrite?: boolean; explicitFieldId?: string; explicitGroupId?: string } = {}
): ApplyPrefillResult {
  const updatedValues = { ...currentValues };
  const updatedStates = { ...fieldStates };
  const conflicts: Array<{ fieldId: string; currentValue: unknown; prefillValue: unknown }> = [];
  const provenanceList: PrefillProvenance[] = [];

  for (const [mappingId, prefillEntry] of Object.entries(cacheEntry.normalizedValues)) {
    if (!prefillEntry || !prefillEntry.available) continue;

    let fieldId: string | undefined = undefined;
    const explicitMapping = (config.mappings || []).find((m) => m.id === mappingId);
    if (explicitMapping) {
      fieldId = explicitMapping.target.fieldId;
    } else if (mappingId.startsWith('auto_')) {
      fieldId = mappingId.slice(5);
    }

    if (!fieldId) continue;

    const fieldBehavior = (config.fieldConfigs || []).find((c) => c.fieldId === fieldId)?.behavior || 'auto';
    if (fieldBehavior === 'none') continue;
    if (fieldBehavior === 'button' && options.explicitFieldId !== fieldId) continue;

    // Explicit field filter
    if (options.explicitFieldId && options.explicitFieldId !== fieldId) continue;

    // Explicit group filter (requires manual mappings since we lack tree structure)
    if (options.explicitGroupId) {
       const mappedToGroup = (config.mappings || []).some((m) => (m.target.fieldId === fieldId || m.id === mappingId) && m.target.groupId === options.explicitGroupId);
       if (!mappedToGroup) continue;
    }

    // Filter if specific mappings subset requested (for legacy/manual compatibility)
    if (mappings && mappings.length > 0 && !options.explicitFieldId && !options.explicitGroupId) {
      const isTargeted = mappings.some((m) => m.target.fieldId === fieldId || m.id === mappingId);
      if (!isTargeted) continue;
    }

    const prefillVal = prefillEntry.value;
    const currentState = getOrCreateFieldState(fieldId, currentValues[fieldId], updatedStates);

    // Overwrite safety check:
    // If field was modified by user (source === 'user' and dirty === true) and confirmOverwrite is true
    if (
      currentState.source === 'user' &&
      currentState.dirty &&
      config.behavior.confirmOverwrite &&
      !options.forceOverwrite &&
      currentState.value !== prefillVal
    ) {
      conflicts.push({
        fieldId,
        currentValue: currentState.value,
        prefillValue: prefillVal,
      });
      continue;
    }

    // Apply prefilled value
    if (typeof prefillVal === 'object' && prefillVal !== null && prefillEntry.unit) {
      updatedValues[fieldId] = { ...(prefillVal as Record<string, unknown>), unit: prefillEntry.unit };
    } else if (prefillEntry.unit && (typeof prefillVal === 'number' || typeof prefillVal === 'string')) {
      updatedValues[fieldId] = { magnitude: prefillVal, unit: prefillEntry.unit };
    } else {
      updatedValues[fieldId] = prefillVal;
    }

    updatedStates[fieldId] = {
      fieldId,
      value: updatedValues[fieldId],
      source: 'aql-prefill',
      dirty: false,
      prefilledValue: prefillVal,
    };

    provenanceList.push({
      plugin: 'aql',
      configurationId: config.id,
      loadedAt: cacheEntry.loadedAt,
      sourceTimestamp: prefillEntry.timestamp,
      sourceDescription: prefillEntry.source,
      queryMode: config.queryMode,
    });
  }

  if (conflicts.length > 0) {
    return {
      updatedValues: currentValues,
      updatedStates: fieldStates,
      provenanceList: [],
      conflicts,
      success: false,
      message: `${conflicts.length} Feld(er) enthalten manuelle Eingaben.`,
    };
  }

  return {
    updatedValues,
    updatedStates,
    provenanceList,
    success: true,
    message: 'Werte erfolgreich übernommen.',
  };
}

/**
 * Applies mapped prefill values for a single form field.
 */
export function applyPrefillField(
  config: AqlPrefillConfiguration,
  cacheEntry: AqlPrefillCacheEntry,
  fieldId: string,
  currentValues: Record<string, unknown>,
  fieldStates: Record<string, PrefillFieldState> = {},
  options: { forceOverwrite?: boolean } = {}
): ApplyPrefillResult {
  return applyMappedValues(config, cacheEntry, [], currentValues, fieldStates, { ...options, explicitFieldId: fieldId });
}

/**
 * Applies mapped prefill values for an openEHR group / cluster.
 */
export function applyPrefillGroup(
  config: AqlPrefillConfiguration,
  cacheEntry: AqlPrefillCacheEntry,
  groupId: string,
  currentValues: Record<string, unknown>,
  fieldStates: Record<string, PrefillFieldState> = {},
  options: { forceOverwrite?: boolean } = {}
): ApplyPrefillResult {
  return applyMappedValues(config, cacheEntry, [], currentValues, fieldStates, { ...options, explicitGroupId: groupId });
}

/**
 * Applies mapped prefill values for the entire form.
 */
export function applyPrefillForm(
  config: AqlPrefillConfiguration,
  cacheEntry: AqlPrefillCacheEntry,
  currentValues: Record<string, unknown>,
  fieldStates: Record<string, PrefillFieldState> = {},
  options: { forceOverwrite?: boolean } = {}
): ApplyPrefillResult {
  return applyMappedValues(config, cacheEntry, config.mappings || [], currentValues, fieldStates, options);
}
