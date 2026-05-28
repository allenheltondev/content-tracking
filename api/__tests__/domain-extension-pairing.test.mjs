import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { ConditionalCheckFailedException } = await import("@aws-sdk/client-dynamodb");
const {
  mintPairing,
  listPairings,
  revokePairing,
  touchPairing,
} = await import("../domain/extension-pairing.mjs");
const { verifyToken } = await import("../services/extension-token.mjs");

const SUB = "abc-123-cognito-sub";
const SECRET = "test-signing-secret-32-chars-long-xx";

describe("domain/extension-pairing", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  describe("mintPairing", () => {
    test("writes pairing metadata and returns a verifiable token", async () => {
      mockSend.mockResolvedValueOnce({});

      const { pairing, token } = await mintPairing({
        sub: SUB,
        label: "My laptop",
        signingSecret: SECRET,
      });

      expect(pairing.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(pairing.label).toBe("My laptop");
      expect(pairing.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(pairing.last_used_at).toBeNull();

      const putInput = mockSend.mock.calls[0][0].input;
      expect(putInput.Item.pk).toBe(`USER#${SUB}`);
      expect(putInput.Item.sk).toBe(`EXTTOKEN#${pairing.jti}`);
      expect(putInput.Item.entity).toBe("ExtensionPairing");
      expect(putInput.ConditionExpression).toMatch(/attribute_not_exists/);

      // The returned token should validate against the same secret and
      // recover the same sub/jti.
      const decoded = verifyToken(token, SECRET);
      expect(decoded.sub).toBe(SUB);
      expect(decoded.jti).toBe(pairing.jti);
    });

    test("defaults the label when none is supplied", async () => {
      mockSend.mockResolvedValueOnce({});
      const { pairing } = await mintPairing({ sub: SUB, signingSecret: SECRET });
      expect(pairing.label).toBe("Unnamed device");
    });

    test("trims the label and treats empty as unnamed", async () => {
      mockSend.mockResolvedValueOnce({});
      const { pairing } = await mintPairing({
        sub: SUB,
        label: "   ",
        signingSecret: SECRET,
      });
      expect(pairing.label).toBe("Unnamed device");
    });

    test("requires sub and signingSecret", async () => {
      await expect(mintPairing({ signingSecret: SECRET })).rejects.toThrow(/requires sub/);
      await expect(mintPairing({ sub: SUB })).rejects.toThrow(/requires signingSecret/);
    });
  });

  describe("listPairings", () => {
    test("queries the user's partition with the EXTTOKEN# prefix", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          {
            pk: `USER#${SUB}`,
            sk: "EXTTOKEN#abc",
            jti: "abc",
            sub: SUB,
            label: "Laptop",
            created_at: "2026-05-01T00:00:00.000Z",
            last_used_at: null,
          },
        ],
      });

      const pairings = await listPairings({ sub: SUB });
      expect(pairings).toEqual([
        {
          jti: "abc",
          label: "Laptop",
          created_at: "2026-05-01T00:00:00.000Z",
          last_used_at: null,
        },
      ]);

      const queryInput = mockSend.mock.calls[0][0].input;
      expect(queryInput.KeyConditionExpression).toMatch(/begins_with\(sk, :sk\)/);
      expect(queryInput.ExpressionAttributeValues).toEqual({
        ":pk": `USER#${SUB}`,
        ":sk": "EXTTOKEN#",
      });
    });

    test("returns an empty array when the user has no pairings", async () => {
      mockSend.mockResolvedValueOnce({});
      expect(await listPairings({ sub: SUB })).toEqual([]);
    });

    test("never echoes the partition keys back to the caller", async () => {
      mockSend.mockResolvedValueOnce({
        Items: [{ pk: `USER#${SUB}`, sk: "EXTTOKEN#x", jti: "x", label: "L", created_at: "t", last_used_at: null }],
      });
      const [pairing] = await listPairings({ sub: SUB });
      expect(pairing.pk).toBeUndefined();
      expect(pairing.sk).toBeUndefined();
      expect(pairing.sub).toBeUndefined();
    });
  });

  describe("revokePairing", () => {
    test("deletes by composite key", async () => {
      mockSend.mockResolvedValueOnce({});
      await revokePairing({ sub: SUB, jti: "abc" });
      const deleteInput = mockSend.mock.calls[0][0].input;
      expect(deleteInput.Key).toEqual({ pk: `USER#${SUB}`, sk: "EXTTOKEN#abc" });
      expect(deleteInput.ConditionExpression).toMatch(/attribute_exists/);
    });

    test("maps a failed conditional check to NotFoundError", async () => {
      mockSend.mockRejectedValueOnce(
        new ConditionalCheckFailedException({ message: "missing", $metadata: {} }),
      );
      await expect(revokePairing({ sub: SUB, jti: "gone" })).rejects.toThrow(/ExtensionPairing/);
    });
  });

  describe("touchPairing", () => {
    test("updates last_used_at and returns the item", async () => {
      mockSend.mockResolvedValueOnce({
        Attributes: {
          pk: `USER#${SUB}`,
          sk: "EXTTOKEN#abc",
          jti: "abc",
          sub: SUB,
          label: "Laptop",
          last_used_at: "2026-05-15T00:00:00.000Z",
        },
      });
      const item = await touchPairing({ sub: SUB, jti: "abc" });
      expect(item).not.toBeNull();
      expect(item.last_used_at).toBe("2026-05-15T00:00:00.000Z");
      const updateInput = mockSend.mock.calls[0][0].input;
      expect(updateInput.UpdateExpression).toMatch(/SET last_used_at = :now/);
      expect(updateInput.ConditionExpression).toMatch(/attribute_exists/);
    });

    test("returns null when the pairing has been revoked", async () => {
      mockSend.mockRejectedValueOnce(
        new ConditionalCheckFailedException({ message: "missing", $metadata: {} }),
      );
      expect(await touchPairing({ sub: SUB, jti: "gone" })).toBeNull();
    });
  });
});
