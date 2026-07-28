export type AqlQueryMode = "latest" | "earliest" | "custom";

export type PrefillExecutionMode = "automatic" | "manual";

export type PrefillApplyScope = "field" | "group" | "form";

export type AqlFieldBehavior = "auto" | "button" | "none";

export interface AqlFieldConfig {
  fieldId: string;
  behavior: AqlFieldBehavior;
}

export type AqlParameterSource = "ehrId" | "patientId" | "encounterId" | "compositionId" | "formField" | "static";

export interface AqlParameterBinding {
  queryParameter: string;
  source: AqlParameterSource;
  fieldId?: string;
  staticValue?: unknown;
}

export interface AqlResultMappingTarget {
  fieldId: string;
  openEhrPath?: string;
  groupId?: string;
}

export interface AqlResultMappingMetadata {
  timestampPath?: string;
  sourcePath?: string;
  unitPath?: string;
}

export interface AqlResultMapping {
  id: string;
  resultPath: string;
  target: AqlResultMappingTarget;
  metadata?: AqlResultMappingMetadata;
}

export interface AqlPrefillBehavior {
  cacheResult: boolean;
  showSource: boolean;
  showTimestamp: boolean;
  confirmOverwrite: boolean;
}

export interface AqlQueryConfig {
  aql?: string;
  archetypeId?: string;
  templateId?: string;
  timeColumn?: string;
}

export interface AqlPrefillConfiguration {
  id: string;
  name: string;
  queryMode: AqlQueryMode;
  executionMode: PrefillExecutionMode;
  query: AqlQueryConfig;
  parameters: AqlParameterBinding[];
  mappings: AqlResultMapping[];
  fieldConfigs?: AqlFieldConfig[];
  behavior: AqlPrefillBehavior;
}

export interface PrefillValue {
  value: unknown;
  unit?: string;
  timestamp?: string;
  source?: string;
  available: boolean;
}

export interface AqlPrefillCacheEntry {
  configurationId: string;
  contextKey: string;
  loadedAt: string;
  rawResult: unknown;
  normalizedValues: Record<string, PrefillValue>;
}

export interface PrefillFieldState {
  fieldId: string;
  value: unknown;
  source: "empty" | "user" | "aql-prefill";
  dirty: boolean;
  prefilledValue?: unknown;
}

export interface PrefillProvenance {
  plugin: "aql";
  configurationId: string;
  loadedAt: string;
  sourceTimestamp?: string;
  sourceDescription?: string;
  queryMode: AqlQueryMode;
}

export interface AqlRequest {
  query: string;
  parameters?: Record<string, unknown>;
}

export interface AqlResponseColumn {
  name: string;
  path?: string;
}

export interface AqlResponse {
  columns?: AqlResponseColumn[];
  rows?: unknown[][];
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PrefillRuntimeContext {
  ehrId?: string;
  patientId?: string;
  encounterId?: string;
  compositionId?: string;
  templateId?: string;
  formValues?: Record<string, unknown>;
  formFields?: Array<{ id: string; aqlPath?: string; name?: string; templateId?: string; rmType?: string; nodeId?: string; }>;
  [key: string]: unknown;
}
