import axios from 'axios';
import type {
  FormDefinitionV1,
  FormScriptConnectorOperationDefinition,
  FormScriptDiagnostic,
} from 'core';
import { getFormScriptConnectorConfiguration } from 'core';
import { getConfig } from '../services/configService';
import { compileFormScript, type FormScriptCompileResult } from './formScriptCompiler';

const MAX_INSTRUCTION_LENGTH = 10_000;
const MAX_GENERATED_SOURCE_LENGTH = 200_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const DIFF_MATRIX_LIMIT = 250_000;

export type FormScriptDiffKind = 'context' | 'add' | 'remove';

export interface FormScriptDiffLine {
  kind: FormScriptDiffKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface FormScriptAiMessage {
  role: 'system' | 'user';
  content: string;
}

export interface FormScriptAiProvider {
  generate(messages: FormScriptAiMessage[], signal?: AbortSignal): Promise<string>;
}

export interface FormScriptAiCandidate {
  candidateSource: string;
  valid: boolean;
  diagnostics: FormScriptDiagnostic[];
  generatedTypes: string;
  diff: FormScriptDiffLine[];
}

export class FormScriptAiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FormScriptAiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices)) return '';
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return '';
  const content = choice.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (
      isRecord(item) && item.type === 'text' && typeof item.text === 'string'
        ? item.text
        : ''
    ))
    .join('');
}

export function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:typescript|ts)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

export class OpenAiCompatibleFormScriptProvider implements FormScriptAiProvider {
  public async generate(
    messages: FormScriptAiMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    const config = getConfig();
    const baseUrl = config.scriptAiBaseUrl?.replace(/\/+$/, '');
    const model = config.scriptAiModel?.trim();
    if (!baseUrl || !model) {
      throw new FormScriptAiError(
        503,
        'FORM_SCRIPT_AI_NOT_CONFIGURED',
        'KI-Codegenerierung ist nicht konfiguriert. Bitte Base URL und Modell in den Systemeinstellungen hinterlegen.',
      );
    }
    let endpoint: URL;
    try {
      endpoint = new URL(`${baseUrl}/chat/completions`);
    } catch {
      throw new FormScriptAiError(
        503,
        'FORM_SCRIPT_AI_CONFIG_INVALID',
        'Die konfigurierte KI Base URL ist ungültig.',
      );
    }
    if (!['http:', 'https:'].includes(endpoint.protocol)) {
      throw new FormScriptAiError(
        503,
        'FORM_SCRIPT_AI_CONFIG_INVALID',
        'Die konfigurierte KI Base URL muss HTTP oder HTTPS verwenden.',
      );
    }

    try {
      const response = await axios.post(
        endpoint.toString(),
        {
          model,
          messages,
          temperature: 0.1,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(config.scriptAiApiKey
              ? { Authorization: `Bearer ${config.scriptAiApiKey}` }
              : {}),
          },
          signal,
          timeout: DEFAULT_TIMEOUT_MS,
          maxContentLength: 1_000_000,
        },
      );
      const content = responseContent(response.data);
      if (!content) {
        throw new FormScriptAiError(
          502,
          'FORM_SCRIPT_AI_EMPTY_RESPONSE',
          'Der KI-Provider hat keinen TypeScript-Code zurückgegeben.',
        );
      }
      return content;
    } catch (error) {
      if (error instanceof FormScriptAiError) throw error;
      if (signal?.aborted) {
        throw new FormScriptAiError(499, 'FORM_SCRIPT_AI_ABORTED', 'KI-Codegenerierung wurde abgebrochen.');
      }
      if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
        throw new FormScriptAiError(408, 'FORM_SCRIPT_AI_TIMEOUT', 'Der KI-Provider hat nicht rechtzeitig geantwortet.');
      }
      throw new FormScriptAiError(
        502,
        'FORM_SCRIPT_AI_PROVIDER_FAILED',
        'Der KI-Provider konnte keinen Codevorschlag erzeugen.',
      );
    }
  }
}

function promptFormDefinition(definition: FormDefinitionV1): Record<string, unknown> {
  return {
    id: definition.id,
    name: definition.name,
    version: definition.version,
    layout: definition.layout,
    bindings: definition.bindings,
    locales: definition.locales,
    settings: definition.settings,
  };
}

function connectorPrompt(
  operations: FormScriptConnectorOperationDefinition[],
): string {
  if (operations.length === 0) return 'No connector operation is enabled for this form.';
  return JSON.stringify(
    operations.map((operation) => ({
      id: operation.id,
      label: operation.label,
      description: operation.description,
      inputSchema: operation.inputSchema,
      outputSchema: operation.outputSchema,
    })),
    null,
    2,
  );
}

export function buildFormScriptAiMessages(
  definition: FormDefinitionV1,
  source: string,
  instruction: string,
  compilation: FormScriptCompileResult,
): FormScriptAiMessage[] {
  const operations = getFormScriptConnectorConfiguration(definition).operations;
  const diagnostics = compilation.document.diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity,
    code: diagnostic.code,
    line: diagnostic.line,
    column: diagnostic.column,
    message: diagnostic.message,
  }));
  return [
    {
      role: 'system',
      content: [
        'You edit the single visible TypeScript source file for a form-builder runtime.',
        'Return the complete form-script.ts source only. Do not return Markdown fences, explanations, JSON, patches, or a second rule representation.',
        'Preserve existing behavior not affected by the request.',
        'Use only the public globals and types declared in the generated declarations.',
        'The only permitted import is from "@formbuilder/runtime". Never use fetch, DOM/browser globals, eval, dynamic import, or direct network access.',
        'Use api.call only with an enabled connector operation id and its declared input schema.',
        'Use exact field, group, tab, and button ids from the form schema. Produce strict, readable TypeScript.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'USER REQUEST',
        instruction,
        '',
        'FORM DEFINITION',
        JSON.stringify(promptFormDefinition(definition), null, 2),
        '',
        'GENERATED TYPES AND RUNTIME API',
        compilation.document.generatedTypes,
        '',
        'ENABLED CONNECTOR OPERATIONS',
        connectorPrompt(operations),
        '',
        'CURRENT COMPILER DIAGNOSTICS',
        diagnostics.length > 0 ? JSON.stringify(diagnostics, null, 2) : 'None.',
        '',
        'CURRENT form-script.ts',
        source,
      ].join('\n'),
    },
  ];
}

function fallbackDiff(oldLines: string[], newLines: string[]): FormScriptDiffLine[] {
  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (
    oldSuffix >= prefix
    && newSuffix >= prefix
    && oldLines[oldSuffix] === newLines[newSuffix]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }
  const result: FormScriptDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (let index = 0; index < prefix; index += 1) {
    result.push({ kind: 'context', text: oldLines[index], oldLine: oldLine++, newLine: newLine++ });
  }
  for (let index = prefix; index <= oldSuffix; index += 1) {
    result.push({ kind: 'remove', text: oldLines[index], oldLine: oldLine++ });
  }
  for (let index = prefix; index <= newSuffix; index += 1) {
    result.push({ kind: 'add', text: newLines[index], newLine: newLine++ });
  }
  for (let index = oldSuffix + 1; index < oldLines.length; index += 1) {
    result.push({ kind: 'context', text: oldLines[index], oldLine: oldLine++, newLine: newLine++ });
  }
  return result;
}

export function createFormScriptLineDiff(
  previousSource: string,
  candidateSource: string,
): FormScriptDiffLine[] {
  const oldLines = previousSource.replace(/\r\n/g, '\n').split('\n');
  const newLines = candidateSource.replace(/\r\n/g, '\n').split('\n');
  if (oldLines.length * newLines.length > DIFF_MATRIX_LIMIT) {
    return fallbackDiff(oldLines, newLines);
  }

  const width = newLines.length + 1;
  const lengths = new Uint32Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * width + newIndex;
      lengths[offset] = oldLines[oldIndex] === newLines[newIndex]
        ? lengths[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(
          lengths[(oldIndex + 1) * width + newIndex],
          lengths[oldIndex * width + newIndex + 1],
        );
    }
  }

  const result: FormScriptDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length
      && newIndex < newLines.length
      && oldLines[oldIndex] === newLines[newIndex]
    ) {
      result.push({
        kind: 'context',
        text: oldLines[oldIndex],
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < newLines.length
      && (
        oldIndex >= oldLines.length
        || lengths[oldIndex * width + newIndex + 1]
          > lengths[(oldIndex + 1) * width + newIndex]
      )
    ) {
      result.push({ kind: 'add', text: newLines[newIndex], newLine: newIndex + 1 });
      newIndex += 1;
    } else {
      result.push({ kind: 'remove', text: oldLines[oldIndex], oldLine: oldIndex + 1 });
      oldIndex += 1;
    }
  }
  return result;
}

export async function generateFormScriptCandidate(
  definition: FormDefinitionV1,
  source: string,
  instruction: string,
  provider: FormScriptAiProvider = new OpenAiCompatibleFormScriptProvider(),
  signal?: AbortSignal,
): Promise<FormScriptAiCandidate> {
  const trimmedInstruction = instruction.trim();
  if (!trimmedInstruction) {
    throw new FormScriptAiError(400, 'FORM_SCRIPT_AI_INSTRUCTION_REQUIRED', 'Bitte eine Anweisung für die KI eingeben.');
  }
  if (trimmedInstruction.length > MAX_INSTRUCTION_LENGTH) {
    throw new FormScriptAiError(
      400,
      'FORM_SCRIPT_AI_INSTRUCTION_TOO_LARGE',
      `Die KI-Anweisung darf höchstens ${MAX_INSTRUCTION_LENGTH} Zeichen enthalten.`,
    );
  }

  const currentCompilation = compileFormScript(definition, source);
  const messages = buildFormScriptAiMessages(
    definition,
    source,
    trimmedInstruction,
    currentCompilation,
  );
  const candidateSource = stripCodeFence(await provider.generate(messages, signal));
  if (!candidateSource) {
    throw new FormScriptAiError(502, 'FORM_SCRIPT_AI_EMPTY_RESPONSE', 'Der KI-Provider hat keinen TypeScript-Code zurückgegeben.');
  }
  if (candidateSource.length > MAX_GENERATED_SOURCE_LENGTH) {
    throw new FormScriptAiError(502, 'FORM_SCRIPT_AI_SOURCE_TOO_LARGE', 'Der KI-Codevorschlag ist zu groß.');
  }

  const compilation = compileFormScript(definition, candidateSource);
  return {
    candidateSource,
    valid: compilation.valid,
    diagnostics: compilation.document.diagnostics,
    generatedTypes: compilation.document.generatedTypes,
    diff: createFormScriptLineDiff(source, candidateSource),
  };
}

interface RateLimitEntry {
  startedAt: number;
  count: number;
}

export class FormScriptAiRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  public constructor(
    private readonly requests = 10,
    private readonly windowMs = 60_000,
  ) {}

  public assertAllowed(key: string): void {
    const now = Date.now();
    const current = this.entries.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      this.entries.set(key, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
    if (current.count > this.requests) {
      throw new FormScriptAiError(
        429,
        'FORM_SCRIPT_AI_RATE_LIMIT',
        'Zu viele KI-Anfragen. Bitte kurz warten und erneut versuchen.',
      );
    }
  }
}

export const formScriptAiRateLimiter = new FormScriptAiRateLimiter();
