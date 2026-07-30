import type { FormScriptLogEntry } from 'core';

type Listener = (entries: FormScriptLogEntry[]) => void;

const logs = new Map<string, FormScriptLogEntry[]>();
const listeners = new Map<string, Set<Listener>>();

export function getScriptLogs(formId: string): FormScriptLogEntry[] {
  return [...(logs.get(formId) || [])];
}

export function appendScriptLog(formId: string, entry: FormScriptLogEntry): void {
  const next = [...(logs.get(formId) || []), entry].slice(-500);
  logs.set(formId, next);
  listeners.get(formId)?.forEach((listener) => listener([...next]));
}

export function clearScriptLogs(formId: string): void {
  logs.set(formId, []);
  listeners.get(formId)?.forEach((listener) => listener([]));
}

export function subscribeScriptLogs(formId: string, listener: Listener): () => void {
  const formListeners = listeners.get(formId) || new Set<Listener>();
  formListeners.add(listener);
  listeners.set(formId, formListeners);
  listener(getScriptLogs(formId));
  return () => {
    formListeners.delete(listener);
    if (formListeners.size === 0) listeners.delete(formId);
  };
}

