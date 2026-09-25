import { describe, it, expect } from 'vitest';
import { crosspostSetupPath, safeReturnPath } from './crosspostSettings';

describe('crosspostSetupPath', () => {
  it('opens the Cross-posting tab on the platform card', () => {
    expect(crosspostSetupPath('medium')).toBe('/settings?tab=crosspost#crosspost-medium');
  });

  it('carries the page to come back to', () => {
    expect(crosspostSetupPath('dev', '/content/C1')).toBe('/settings?tab=crosspost&from=%2Fcontent%2FC1#crosspost-dev');
  });
});

// `from` arrives in a URL anyone can craft, and it is rendered as a link.
describe('safeReturnPath', () => {
  it('accepts an in-app path', () => {
    expect(safeReturnPath('/content/C1')).toBe('/content/C1');
  });

  it.each([
    ['absolute URL', 'https://evil.example/phish'],
    ['protocol-relative URL', '//evil.example/phish'],
    ['backslash trick', '/\\evil.example'],
    ['javascript URL', 'javascript:alert(1)'],
    ['relative path', 'content/C1'],
    ['empty', ''],
  ])('rejects a %s', (_label, value) => {
    expect(safeReturnPath(value)).toBeNull();
  });

  it('treats a missing value as no return link', () => {
    expect(safeReturnPath(null)).toBeNull();
  });
});
