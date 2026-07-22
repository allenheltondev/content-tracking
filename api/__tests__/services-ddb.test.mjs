import { jest } from "@jest/globals";

const {
  buildUpdateExpression,
  isConditionalCheckFailed,
  mapConditionalFailure,
} = await import("../services/ddb.mjs");
const { NotFoundError } = await import("../services/errors.mjs");

describe("services/ddb", () => {
  describe("buildUpdateExpression", () => {
    test("SET for values, REMOVE for nulls, updatedAt stamped first", () => {
      const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues } =
        buildUpdateExpression({ name: "Acme", notes: null });

      expect(UpdateExpression).toBe(
        "SET #updatedAt = :updatedAt, #name = :name REMOVE #notes",
      );
      expect(ExpressionAttributeNames).toEqual({
        "#updatedAt": "updatedAt",
        "#name": "name",
        "#notes": "notes",
      });
      expect(ExpressionAttributeValues[":name"]).toBe("Acme");
      expect(ExpressionAttributeValues[":updatedAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(ExpressionAttributeValues).not.toHaveProperty(":notes");
    });

    test("no REMOVE section when nothing is cleared", () => {
      const { UpdateExpression } = buildUpdateExpression({ title: "Hello" });
      expect(UpdateExpression).toBe("SET #updatedAt = :updatedAt, #title = :title");
    });

    test("skip drops protected fields (Set or array)", () => {
      const asSet = buildUpdateExpression({ pk: "x", title: "Hi" }, { skip: new Set(["pk"]) });
      expect(asSet.UpdateExpression).not.toContain("#pk");

      const asArray = buildUpdateExpression({ pk: "x", title: "Hi" }, { skip: ["pk"] });
      expect(asArray.UpdateExpression).not.toContain("#pk");
      expect(asArray.ExpressionAttributeNames).not.toHaveProperty("#pk");
    });

    test("extraSet clauses append with their names and values", () => {
      const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues } =
        buildUpdateExpression(
          { canonicalUrl: "https://e.com/post" },
          {
            extraSet: ["#links.#url = :canonicalUrl"],
            extraNames: { "#links": "links", "#url": "url" },
            extraValues: { ":canonicalUrl": "https://e.com/post" },
          },
        );

      expect(UpdateExpression).toBe(
        "SET #updatedAt = :updatedAt, #canonicalUrl = :canonicalUrl, #links.#url = :canonicalUrl",
      );
      expect(ExpressionAttributeNames["#links"]).toBe("links");
      expect(ExpressionAttributeValues[":canonicalUrl"]).toBe("https://e.com/post");
    });
  });

  describe("isConditionalCheckFailed", () => {
    test("matches by error name across bundling/mocking boundaries", () => {
      const err = new Error("boom");
      err.name = "ConditionalCheckFailedException";
      expect(isConditionalCheckFailed(err)).toBe(true);
    });

    test("false for other errors and non-errors", () => {
      expect(isConditionalCheckFailed(new Error("nope"))).toBe(false);
      expect(isConditionalCheckFailed(undefined)).toBe(false);
    });
  });

  describe("mapConditionalFailure", () => {
    test("passes the wrapped result through", async () => {
      await expect(mapConditionalFailure("Vendor", "V1", async () => 42)).resolves.toBe(42);
    });

    test("converts a condition failure into NotFoundError", async () => {
      const err = new Error("The conditional request failed");
      err.name = "ConditionalCheckFailedException";
      const fn = jest.fn().mockRejectedValue(err);

      await expect(mapConditionalFailure("Vendor", "V1", fn)).rejects.toThrow(NotFoundError);
      await expect(mapConditionalFailure("Vendor", "V1", fn)).rejects.toThrow(/Vendor V1 not found/);
    });

    test("rethrows unrelated errors untouched", async () => {
      const err = new Error("throughput exceeded");
      await expect(
        mapConditionalFailure("Vendor", "V1", async () => { throw err; }),
      ).rejects.toBe(err);
    });
  });
});
