// Extends Vitest's `expect` with jest-dom matchers (toBeInTheDocument,
// toHaveTextContent, ...) and their TS types - the /vitest entry point
// wires up both in one import, no separate expect.extend() call needed.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Without this, every render() in a test file stays mounted into the same
// jsdom document for the rest of that file - a later test's screen.getByX
// can then match a leftover element from an earlier test (or blow up as
// "found multiple elements") for reasons that have nothing to do with the
// component under test. testing-library/react auto-registers this itself
// when it detects vitest's `globals: true`, which this project doesn't
// enable (test files import describe/it/expect explicitly instead), so it
// has to be done explicitly here.
afterEach(() => { cleanup(); });
