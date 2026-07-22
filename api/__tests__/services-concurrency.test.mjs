const { runInBatches } = await import("../services/concurrency.mjs");

describe("services/concurrency", () => {
  test("preserves order across batches", async () => {
    const ops = [1, 2, 3, 4, 5].map((n) => async () => n * 10);
    await expect(runInBatches(ops, 2)).resolves.toEqual([10, 20, 30, 40, 50]);
  });

  test("caps how many ops run at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const ops = Array.from({ length: 9 }, (_, i) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return i;
    });

    await runInBatches(ops, 3);

    expect(peak).toBeLessThanOrEqual(3);
  });

  test("a rejection propagates", async () => {
    const ops = [async () => 1, async () => { throw new Error("boom"); }];
    await expect(runInBatches(ops, 2)).rejects.toThrow("boom");
  });

  test("empty input resolves to an empty array", async () => {
    await expect(runInBatches([], 4)).resolves.toEqual([]);
  });
});
