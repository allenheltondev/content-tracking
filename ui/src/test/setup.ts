// Vitest setup: extend expect with jest-dom matchers (toBeInTheDocument, ...)
// and clean up the DOM between tests.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom doesn't implement scrollIntoView; stub it so components that call it in
// effects (e.g. the active-suggestion auto-scroll) don't throw under test.
window.HTMLElement.prototype.scrollIntoView = () => {};

afterEach(() => {
  cleanup();
});
