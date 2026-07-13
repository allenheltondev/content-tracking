import { describe, it, expect } from 'vitest';
import { parseList, slugify } from './text';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('My Cool Post')).toBe('my-cool-post');
  });

  it('collapses runs of non-alphanumerics and trims edges', () => {
    expect(slugify('  Hello, World!! ')).toBe('hello-world');
    expect(slugify('a---b')).toBe('a-b');
  });

  it('drops accents via NFKD normalization', () => {
    expect(slugify('Café')).toBe('cafe');
  });
});

describe('parseList', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseList('react,  typescript , ,vite')).toEqual(['react', 'typescript', 'vite']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseList('   ')).toEqual([]);
    expect(parseList('')).toEqual([]);
  });
});
