// Vitest setup: extend expect with jest-dom matchers (toBeInTheDocument, ...)
// and clean up the DOM between tests.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
