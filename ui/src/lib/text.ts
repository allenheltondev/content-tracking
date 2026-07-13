// Small text helpers shared across content forms. Extracted so they can be
// unit-tested independently of the components that use them.

// Turns a title into a server-acceptable kebab-case slug.
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Splits a comma-separated input into a trimmed, de-empty'd list.
export function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
