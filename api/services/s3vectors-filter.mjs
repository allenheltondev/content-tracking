// Helpers for building S3 Vectors metadata query filters.
//
// S3 Vectors does NOT support an implicit AND across different metadata keys.
// A top-level object carrying more than one key (e.g. { tenantId, type }) is
// rejected by the QueryVectors API as an invalid filter. Multiple conditions
// on different keys must be combined under an explicit $and:
//
//   { $and: [ { tenantId: "T1" }, { type: "blog" } ] }
//
// A single condition is valid on its own (S3 Vectors applies an implicit $eq),
// so we pass it through unwrapped.

// Combines equality conditions with $and, dropping null/undefined clauses so
// callers can inline optional narrowing keys. Returns undefined when nothing
// is left to filter on (a query with no filter is valid).
export function andFilter(clauses) {
  const active = clauses.filter((c) => c != null);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return { $and: active };
}
