import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  dispatchFormWorkerMessage,
  type FormHostOperations,
  type FormWorkerToHostMessage,
} from './formScriptProtocol';

function createOps(): FormHostOperations {
  return {
    onReady: vi.fn(),
    onInitError: vi.fn(),
    onResponse: vi.fn(),
    onValidationErrors: vi.fn(),
    onSetValue: vi.fn(),
    onUpdateValues: vi.fn(),
    onApiCall: vi.fn(),
    onApiCancel: vi.fn(),
    onUiState: vi.fn(),
    onToast: vi.fn(),
    onPrefillConflict: vi.fn(),
    onLog: vi.fn(),
  };
}

const validationErrors = {
  f1: { message: 'Ungültig', severity: 'error' as const, source: 'script' as const },
};

const logEntry = {
  id: 'log-1',
  timestamp: '2026-01-01T10:00:00.000Z',
  level: 'info' as const,
  message: 'Hallo',
};

const prefillConflictWithoutTimestamp = {
  type: 'prefill:conflict',
  requestId: 'prefill-1',
  fieldId: 'f1',
  currentValue: 'own',
  prefillValue: 'aql',
  source: 'aql',
};

const apiCall = { type: 'api:call', requestId: 'api-1', operation: 'lookup', input: { id: '1' } };

describe('dispatchFormWorkerMessage', () => {
  it.each([
    ['ready', { type: 'ready' }, 'onReady', []],
    ['init-error with message', { type: 'init-error', message: 'kaputt' }, 'onInitError', ['kaputt']],
    [
      'init-error without message',
      { type: 'init-error' },
      'onInitError',
      ['Form Script konnte nicht initialisiert werden.'],
    ],
    ['response', { type: 'response', requestId: 'req-1', result: { ok: true } }, 'onResponse', ['req-1', { ok: true }]],
    ['validation:errors', { type: 'validation:errors', errors: validationErrors }, 'onValidationErrors', [validationErrors]],
    [
      'form:set-value with provenance and persist false',
      {
        type: 'form:set-value',
        id: 'f1',
        value: 'v',
        persist: false,
        provenance: { kind: 'prefill', source: 'aql', timestamp: '2026-01-01T10:00:00.000Z' },
      },
      'onSetValue',
      ['f1', 'v', false, { kind: 'prefill', source: 'aql', timestamp: '2026-01-01T10:00:00.000Z' }],
    ],
    [
      'form:set-value without persist and provenance defaults to persist true and null provenance',
      { type: 'form:set-value', id: 'f1', value: 'v' },
      'onSetValue',
      ['f1', 'v', true, null],
    ],
    [
      'form:update-values with persist false',
      { type: 'form:update-values', values: { f1: 'x' }, persist: false },
      'onUpdateValues',
      [{ f1: 'x' }, false],
    ],
    [
      'form:update-values without persist defaults to true',
      { type: 'form:update-values', values: { f1: 'x' } },
      'onUpdateValues',
      [{ f1: 'x' }, true],
    ],
    ['api:call', apiCall, 'onApiCall', [apiCall]],
    ['api:cancel', { type: 'api:cancel', requestId: 'api-1' }, 'onApiCancel', ['api-1']],
    [
      'ui:set-state',
      { type: 'ui:set-state', kind: 'field', id: 'f1', state: { visible: false, label: 'Neu' } },
      'onUiState',
      ['field', 'f1', { visible: false, label: 'Neu' }],
    ],
    ['ui:toast', { type: 'ui:toast', level: 'info', message: 'hi' }, 'onToast', ['info', 'hi']],
    [
      'prefill:conflict without timestamp has no timestamp key',
      prefillConflictWithoutTimestamp,
      'onPrefillConflict',
      [{ requestId: 'prefill-1', fieldId: 'f1', currentValue: 'own', prefillValue: 'aql', source: 'aql' }],
    ],
    [
      'prefill:conflict with timestamp',
      { ...prefillConflictWithoutTimestamp, timestamp: '2026-01-01T10:00:00.000Z' },
      'onPrefillConflict',
      [
        {
          requestId: 'prefill-1',
          fieldId: 'f1',
          currentValue: 'own',
          prefillValue: 'aql',
          source: 'aql',
          timestamp: '2026-01-01T10:00:00.000Z',
        },
      ],
    ],
    ['log', { type: 'log', entry: logEntry }, 'onLog', [logEntry]],
  ] as Array<[string, FormWorkerToHostMessage, keyof FormHostOperations, unknown[]]>)(
    'routes %s',
    (_label, message, operation, args) => {
      const ops = createOps();

      expect(dispatchFormWorkerMessage(message, ops)).toBe(true);

      for (const [name, handler] of Object.entries(ops)) {
        if (name === operation) {
          expect(handler).toHaveBeenCalledTimes(1);
        } else {
          expect(handler).not.toHaveBeenCalled();
        }
      }
      expect(ops[operation]).toHaveBeenCalledWith(...args);

      if (operation === 'onPrefillConflict') {
        const conflict = (ops.onPrefillConflict as Mock).mock.calls[0][0] as Record<string, unknown>;
        expect(conflict).not.toHaveProperty('type');
        if (message.type === 'prefill:conflict' && typeof message.timestamp !== 'string') {
          expect(conflict).not.toHaveProperty('timestamp');
        }
      }
    },
  );

  it('returns false and calls no operation for unknown or non-object messages', () => {
    const ops = createOps();

    expect(dispatchFormWorkerMessage({ type: 'nope' }, ops)).toBe(false);
    expect(dispatchFormWorkerMessage(null, ops)).toBe(false);
    expect(dispatchFormWorkerMessage('ready', ops)).toBe(false);

    for (const handler of Object.values(ops)) {
      expect(handler).not.toHaveBeenCalled();
    }
  });
});
