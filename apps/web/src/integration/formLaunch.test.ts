import { describe, expect, it } from 'vitest';
import { FORM_LAUNCH_PROTOCOL_VERSION, type FormEmbedEventName } from 'core';
import { isFormEmbedEvent } from './formLaunch';

function event(name: string, overrides: Record<string, unknown> = {}) {
  return { protocolVersion: FORM_LAUNCH_PROTOCOL_VERSION, event: name, formId: 'form-1', ...overrides };
}

// QA review finding: isFormEmbedEvent's whitelist previously omitted
// 'dirty' entirely - every 'dirty' postMessage from an embedded child
// form was silently rejected before CompositionRuntime.tsx's unsaved-
// changes navigation guard ever saw it, making that guard dead code.
describe('isFormEmbedEvent', () => {
  // Every real FormEmbedEventName must be accepted - listing them
  // explicitly (rather than looping some other derived list) means this
  // test itself won't compile if `core`'s FormEmbedEventName union gains
  // a member this array doesn't also get, the same "TypeScript catches a
  // drifted enum" property the fix itself relies on.
  const allEventNames: FormEmbedEventName[] = ['loaded', 'submitted', 'error', 'resize', 'dirty'];

  it.each(allEventNames)('accepts a real "%s" event', (name) => {
    expect(isFormEmbedEvent(event(name))).toBe(true);
  });

  it('accepts a "dirty" event carrying its dirty flag', () => {
    expect(isFormEmbedEvent(event('dirty', { dirty: true, launchId: 'session-1:block-a' }))).toBe(true);
  });

  it('rejects an unknown event name', () => {
    expect(isFormEmbedEvent(event('not-a-real-event'))).toBe(false);
  });

  it('rejects a mismatched protocol version', () => {
    expect(isFormEmbedEvent(event('dirty', { protocolVersion: 'wrong-version' }))).toBe(false);
  });

  it('rejects a missing formId', () => {
    expect(isFormEmbedEvent({ protocolVersion: FORM_LAUNCH_PROTOCOL_VERSION, event: 'dirty' })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isFormEmbedEvent(null)).toBe(false);
    expect(isFormEmbedEvent(undefined)).toBe(false);
    expect(isFormEmbedEvent('dirty')).toBe(false);
    expect(isFormEmbedEvent(42)).toBe(false);
  });
});
