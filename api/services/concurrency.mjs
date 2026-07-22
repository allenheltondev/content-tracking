// Bounded-concurrency execution for fan-out reads (DynamoDB queries,
// upstream analytics calls). An unbounded Promise.all over hundreds of
// operations risks DynamoDB throttling and long tail latency; batching
// caps how many are in flight at once while keeping the code shape close
// to a plain map.

export const FANOUT_CONCURRENCY = parseInt(
  process.env.ANALYTICS_FANOUT_CONCURRENCY || "10", 10,
);

// Runs an array of thunks batchSize at a time, preserving order. Each op
// is a () => Promise; rejections propagate, so wrap individual ops in
// try/catch when partial failure should not abort the whole fan-out.
export async function runInBatches(ops, batchSize = FANOUT_CONCURRENCY) {
  const results = [];
  for (let i = 0; i < ops.length; i += batchSize) {
    const batch = ops.slice(i, i + batchSize);
    const settled = await Promise.all(batch.map((fn) => fn()));
    results.push(...settled);
  }
  return results;
}
