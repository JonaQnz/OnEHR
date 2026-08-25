import type {
  FormDefinitionV1,
  FormScriptConnectorOperationDefinition,
  FormScriptJsonSchema,
} from 'core';
import type { Principal } from 'core';
import {
  FORM_SCRIPTING_EXTENSION_KEY,
  getFormScriptConnectorConfiguration,
} from 'core';
import type { UserAuthMode } from './configService';
import { getConfig, getPluginSettings } from './configService';
import { resolveActiveEhrbaseAuthorizationHeader } from './ehrbaseConnectionPlugins';
import { pluginRegistry } from '../plugins/pluginRegistry';

export interface ScriptConnectorContext {
  formId: string;
  form: FormDefinitionV1;
  userId: string;
  authMode: Exclude<UserAuthMode, 'disabled-development-only'>;
  principal?: Principal;
  patientId?: string;
  ehrId?: string;
  encounterId?: string;
  sessionId?: string;
  authorization?: string;
}

export interface ScriptConnectorOperation<Input = unknown, Output = unknown>
  extends FormScriptConnectorOperationDefinition {
  timeoutMs?: number;
  handler(
    input: Input,
    context: ScriptConnectorContext,
    signal: AbortSignal,
  ): Promise<Output>;
}

export class ScriptConnectorError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ScriptConnectorError';
  }
}

const OPERATION_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 60;
const MAX_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSchema(
  value: unknown,
  schema: FormScriptJsonSchema,
  path = 'input',
  output = false,
): void {
  const invalid = (message: string) => new ScriptConnectorError(
    output ? 502 : 400,
    output ? 'SCRIPT_CONNECTOR_OUTPUT_INVALID' : 'SCRIPT_CONNECTOR_INPUT_INVALID',
    message,
  );
  if (schema.enum && !schema.enum.some((item) => jsonEqual(item, value))) {
    throw invalid(`${path} has an unsupported value.`);
  }
  if (schema.type === 'null' && value !== null) {
    throw invalid(`${path} must be null.`);
  }
  if (schema.type === 'string' && typeof value !== 'string') {
    throw invalid(`${path} must be a string.`);
  }
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw invalid(`${path} must be a finite number.`);
  }
  if (schema.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) {
    throw invalid(`${path} must be an integer.`);
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    throw invalid(`${path} must be a boolean.`);
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      throw invalid(`${path} must be an array.`);
    }
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items as FormScriptJsonSchema, `${path}[${index}]`, output));
  }
  if (schema.type === 'object' || schema.properties) {
    if (!isRecord(value)) {
      throw invalid(`${path} must be an object.`);
    }
    for (const required of schema.required || []) {
      if (!(required in value)) {
        throw invalid(`${path}.${required} is required.`);
      }
    }
    Object.entries(value).forEach(([key, item]) => {
      const propertySchema = schema.properties?.[key];
      if (propertySchema) {
        validateSchema(item, propertySchema, `${path}.${key}`, output);
        return;
      }
      if (schema.additionalProperties === false) {
        throw invalid(`${path}.${key} is not allowed.`);
      }
      if (isRecord(schema.additionalProperties)) {
        validateSchema(item, schema.additionalProperties as FormScriptJsonSchema, `${path}.${key}`, output);
      }
    });
  }
}

function publicDefinition(
  operation: FormScriptConnectorOperationDefinition,
): FormScriptConnectorOperationDefinition {
  return {
    id: operation.id,
    label: operation.label,
    ...(operation.description ? { description: operation.description } : {}),
    permissions: [...operation.permissions],
    inputSchema: operation.inputSchema,
    outputSchema: operation.outputSchema,
  };
}

interface RateLimitEntry {
  startedAt: number;
  count: number;
}

export class ScriptConnectorRegistry {
  private readonly operations = new Map<string, ScriptConnectorOperation>();
  private readonly rateLimits = new Map<string, RateLimitEntry>();

  public register(operation: ScriptConnectorOperation): void {
    if (!OPERATION_ID.test(operation.id)) {
      throw new Error(`Invalid script connector operation id: ${operation.id}`);
    }
    if (this.operations.has(operation.id)) {
      throw new Error(`Script connector operation ${operation.id} is already registered`);
    }
    if (typeof operation.handler !== 'function') {
      throw new Error(`Script connector operation ${operation.id} requires a handler`);
    }
    this.operations.set(operation.id, operation);
  }

  public unregister(id: string): boolean {
    return this.operations.delete(id);
  }

  private pluginDefinitions(): FormScriptConnectorOperationDefinition[] {
    return pluginRegistry.getContributions()
      .filter((contribution) => contribution.extensionPoint === 'scripting')
      .map((contribution) => {
        const scripting = contribution as typeof contribution & {
          operationId: string;
          label: string;
          description?: string;
          permissions?: string[];
          inputSchema: FormScriptJsonSchema;
          outputSchema: FormScriptJsonSchema;
        };
        return {
          id: `${contribution.pluginId}.${scripting.operationId}`,
          label: scripting.label,
          ...(scripting.description ? { description: scripting.description } : {}),
          permissions: [...(scripting.permissions || [])],
          inputSchema: scripting.inputSchema,
          outputSchema: scripting.outputSchema,
        };
      });
  }

  public list(): FormScriptConnectorOperationDefinition[] {
    const builtIns = [...this.operations.values()].map(publicDefinition);
    return [...builtIns, ...this.pluginDefinitions()].sort((left, right) => left.id.localeCompare(right.id));
  }

  public getDefinition(id: string): FormScriptConnectorOperationDefinition | undefined {
    return this.list().find((operation) => operation.id === id);
  }

  private assertRateLimit(context: ScriptConnectorContext, operationId: string): void {
    const now = Date.now();
    const key = `${context.userId}:${context.formId}:${operationId}`;
    const current = this.rateLimits.get(key);
    if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
      this.rateLimits.set(key, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > RATE_LIMIT_REQUESTS) {
      throw new ScriptConnectorError(429, 'SCRIPT_CONNECTOR_RATE_LIMIT', 'Too many script connector requests.');
    }
  }

  private async executePlugin(
    operationId: string,
    input: unknown,
    context: ScriptConnectorContext,
  ): Promise<unknown> {
    const contribution = pluginRegistry.getContributions().find((item) => (
      item.extensionPoint === 'scripting'
      && `${item.pluginId}.${(item as { operationId?: string }).operationId}` === operationId
    )) as (ReturnType<typeof pluginRegistry.getContributions>[number] & { actionId: string }) | undefined;
    if (!contribution) {
      throw new ScriptConnectorError(404, 'SCRIPT_CONNECTOR_UNKNOWN', `Unknown script connector operation: ${operationId}`);
    }
    // See pluginRoutes.ts for why this is resolved here rather than by the
    // plugin itself.
    const needsEhrbaseAuth = contribution.pluginId === 'org.openehr.aql-prefill';
    const result = await pluginRegistry.runAction(contribution.pluginId, contribution.actionId, {
      formId: context.formId,
      patientId: context.patientId,
      sessionId: context.sessionId,
      userId: context.userId,
      form: context.form as unknown as Record<string, any>,
      data: isRecord(input) ? input as Record<string, any> : { value: input as any },
      metadata: {
        authMode: context.authMode,
        ...(context.ehrId ? { ehrId: context.ehrId } : {}),
        ...(context.encounterId ? { encounterId: context.encounterId } : {}),
        pluginSettings: getPluginSettings(contribution.pluginId) as any,
        ...(context.authorization ? { authorization: context.authorization } : (needsEhrbaseAuth ? { authorization: await resolveActiveEhrbaseAuthorizationHeader().catch(() => undefined) } : {})),
        ...(needsEhrbaseAuth ? { ehrbaseUrl: getConfig().ehrbaseUrl } : {}),
        source: 'form-script',
      },
    });
    if (result.errors && result.errors.length > 0) {
      throw new ScriptConnectorError(422, 'SCRIPT_CONNECTOR_PLUGIN_ERROR', result.errors.map((error) => error.message).join(' '));
    }
    return result.data ?? result;
  }

  public async execute(
    operationId: string,
    input: unknown,
    context: ScriptConnectorContext,
    externalSignal?: AbortSignal,
    requestedTimeoutMs?: number,
  ): Promise<unknown> {
    const definition = this.getDefinition(operationId);
    if (!definition) {
      throw new ScriptConnectorError(404, 'SCRIPT_CONNECTOR_UNKNOWN', `Unknown script connector operation: ${operationId}`);
    }
    const allowed = getFormScriptConnectorConfiguration(context.form).allowedOperations;
    if (!allowed.includes(operationId)) {
      throw new ScriptConnectorError(403, 'SCRIPT_CONNECTOR_FORBIDDEN', `Operation ${operationId} is not enabled for this form.`);
    }
    validateSchema(input, definition.inputSchema);
    this.assertRateLimit(context, operationId);

    const operation = this.operations.get(operationId);
    const timeoutMs = Math.min(
      Math.max(requestedTimeoutMs || operation?.timeoutMs || 10_000, 100),
      MAX_TIMEOUT_MS,
    );
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    externalSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const startedAt = Date.now();
    const abortError = () => new ScriptConnectorError(
      timedOut ? 408 : 499,
      timedOut ? 'SCRIPT_CONNECTOR_TIMEOUT' : 'SCRIPT_CONNECTOR_ABORTED',
      timedOut ? `Operation ${operationId} timed out.` : `Operation ${operationId} was aborted.`,
    );
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(abortError());
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });

    try {
      const execution = operation
        ? operation.handler(input, context, controller.signal)
        : this.executePlugin(operationId, input, context);
      const result = await Promise.race([execution, aborted]);
      validateSchema(result, definition.outputSchema, 'result', true);
      console.info('[SCRIPT CONNECTOR]', {
        operation: operationId,
        formId: context.formId,
        userId: context.userId,
        durationMs: Date.now() - startedAt,
        status: 'success',
      });
      return result;
    } catch (error) {
      console.warn('[SCRIPT CONNECTOR]', {
        operation: operationId,
        formId: context.formId,
        userId: context.userId,
        durationMs: Date.now() - startedAt,
        status: timedOut ? 'timeout' : controller.signal.aborted ? 'aborted' : 'error',
      });
      if (error instanceof ScriptConnectorError) throw error;
      if (controller.signal.aborted) {
        throw abortError();
      }
      throw new ScriptConnectorError(502, 'SCRIPT_CONNECTOR_FAILED', `Operation ${operationId} failed.`);
    } finally {
      clearTimeout(timer);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
      externalSignal?.removeEventListener('abort', abort);
    }
  }
}

export const scriptConnectorRegistry = new ScriptConnectorRegistry();

scriptConnectorRegistry.register({
  id: 'patient.get',
  label: 'Patient laden',
  description: 'Lädt einen Patienten aus dem serverseitigen Patientenverzeichnis.',
  permissions: ['patient:read'],
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      patientId: { type: 'string' },
      patientNamespace: { type: 'string' },
      firstName: { type: 'string' },
      lastName: { type: 'string' },
      birthDate: { type: 'string' },
      gender: { type: 'string' },
      ehrId: { type: 'string' },
    },
    required: ['id', 'patientId', 'firstName', 'lastName', 'ehrId'],
    additionalProperties: true,
  },
  async handler(input: { id?: string }, context) {
    const id = input.id || context.patientId;
    if (!id) {
      throw new ScriptConnectorError(400, 'SCRIPT_CONNECTOR_INPUT_INVALID', 'A patient id is required.');
    }
    const { getPatientByIdentifier } = await import('./patientService');
    const patient = await getPatientByIdentifier(id);
    if (!patient) throw new ScriptConnectorError(404, 'SCRIPT_CONNECTOR_NOT_FOUND', 'Patient not found.');
    return patient;
  },
});

export function hydrateFormScriptConnectors(
  definition: FormDefinitionV1,
  allowedOverride?: string[],
): FormDefinitionV1 {
  const current = getFormScriptConnectorConfiguration(definition);
  const allowedOperations = [...new Set(allowedOverride || current.allowedOperations)].sort();
  const operations = allowedOperations.map((id) => {
    const operation = scriptConnectorRegistry.getDefinition(id);
    if (!operation) {
      throw new ScriptConnectorError(422, 'SCRIPT_CONNECTOR_UNKNOWN', `Unknown script connector operation: ${id}`);
    }
    return operation;
  });
  return {
    ...definition,
    extensions: {
      ...definition.extensions,
      [FORM_SCRIPTING_EXTENSION_KEY]: {
        allowedOperations,
        operations,
      } as any,
    },
  };
}
