import {
  validateRecommendationRequest,
  formatEngagementRecommendation,
} from "../validation/engagement-recommendation.mjs";

describe("validation/engagement-recommendation", () => {
  describe("validateRecommendationRequest", () => {
    test("treats a missing body as no guidance", () => {
      expect(validateRecommendationRequest(undefined)).toEqual({});
      expect(validateRecommendationRequest(null)).toEqual({});
      expect(validateRecommendationRequest({})).toEqual({});
    });

    test("trims and keeps a goal", () => {
      expect(validateRecommendationRequest({ goal: "  developer signups  " })).toEqual({
        goal: "developer signups",
      });
    });

    test("drops a blank goal", () => {
      expect(validateRecommendationRequest({ goal: "   " })).toEqual({});
    });

    test("rejects a non-object body", () => {
      expect(() => validateRecommendationRequest([])).toThrow(/must be a JSON object/);
    });

    test("rejects an over-long goal", () => {
      expect(() => validateRecommendationRequest({ goal: "x".repeat(501) })).toThrow(/up to 500/);
    });

    test("rejects a non-string goal", () => {
      expect(() => validateRecommendationRequest({ goal: 42 })).toThrow(/must be a string/);
    });
  });

  describe("formatEngagementRecommendation", () => {
    test("maps the stored row to the snake_case API shape", () => {
      const out = formatEngagementRecommendation({
        campaignId: "C1",
        postId: "P1",
        summary: "Push it.",
        recommendations: [
          {
            channel: "reddit r/webdev",
            action: "promote",
            priority: "high",
            rationale: "fits the audience",
            suggested_message: "Check this out",
          },
        ],
        alreadyCovered: ["x"],
        generatedAt: "2026-06-01T00:00:00.000Z",
      });

      expect(out).toEqual({
        campaign_id: "C1",
        post_id: "P1",
        summary: "Push it.",
        recommendations: [
          {
            channel: "reddit r/webdev",
            action: "promote",
            priority: "high",
            rationale: "fits the audience",
            suggested_message: "Check this out",
          },
        ],
        already_covered: ["x"],
        generated_at: "2026-06-01T00:00:00.000Z",
      });
    });

    test("tolerates a row with no recommendations", () => {
      const out = formatEngagementRecommendation({
        campaignId: "C1",
        postId: "P1",
        generatedAt: "2026-06-01T00:00:00.000Z",
      });
      expect(out.summary).toBeNull();
      expect(out.recommendations).toEqual([]);
      expect(out.already_covered).toEqual([]);
    });
  });
});
