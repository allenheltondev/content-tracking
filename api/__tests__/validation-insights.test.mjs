import { describe, expect, test } from "@jest/globals";
import { parseInsightsQuery } from "../validation/insights.mjs";

describe("parseInsightsQuery", () => {
  test("defaults to a trailing 90-day window when neither bound is given", () => {
    const { startDate, endDate } = parseInsightsQuery({});
    const span =
      Math.round(
        (new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) /
          (24 * 60 * 60 * 1000),
      ) + 1;
    expect(span).toBe(90);
    expect(endDate).toBe(new Date().toISOString().slice(0, 10));
  });

  test("accepts a valid explicit range", () => {
    expect(parseInsightsQuery({ startDate: "2026-01-01", endDate: "2026-01-31" })).toEqual({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
  });

  test("requires both bounds together", () => {
    expect(() => parseInsightsQuery({ startDate: "2026-01-01" })).toThrow(/both/);
    expect(() => parseInsightsQuery({ endDate: "2026-01-31" })).toThrow(/both/);
  });

  test("rejects malformed and impossible dates", () => {
    expect(() => parseInsightsQuery({ startDate: "01-01-2026", endDate: "2026-01-31" })).toThrow(/valid ISO/);
    expect(() => parseInsightsQuery({ startDate: "2026-02-30", endDate: "2026-03-01" })).toThrow(/valid ISO/);
  });

  test("rejects an inverted range", () => {
    expect(() => parseInsightsQuery({ startDate: "2026-02-01", endDate: "2026-01-01" })).toThrow(
      /on or before/,
    );
  });

  test("rejects a range over the max span", () => {
    expect(() => parseInsightsQuery({ startDate: "2024-01-01", endDate: "2026-12-31" })).toThrow(
      /at most 730 days/,
    );
  });
});
