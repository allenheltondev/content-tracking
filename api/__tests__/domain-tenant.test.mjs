import { jest } from "@jest/globals";

process.env.TABLE_NAME = "test-booked";
process.env.ENVIRONMENT = "staging";

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { getTenant, upsertTenant, listTenants, tenantConfigKey } = await import("../domain/tenant.mjs");

const TENANT = "tenant-sub-123";

describe("domain/tenant", () => {
  let mockSend;

  beforeEach(() => {
    mockSend = jest.fn();
    DynamoDBDocumentClient.prototype.send = mockSend;
    jest.clearAllMocks();
  });

  test("tenantConfigKey targets the #CONFIG row under the tenant partition", () => {
    expect(tenantConfigKey(TENANT)).toEqual({ pk: `TENANT#${TENANT}`, sk: "#CONFIG" });
  });

  describe("getTenant", () => {
    test("returns the item", async () => {
      mockSend.mockResolvedValue({ Item: { tenantId: TENANT, adminEmail: "a@b.co" } });
      expect(await getTenant(TENANT)).toEqual({ tenantId: TENANT, adminEmail: "a@b.co" });
    });

    test("returns null when unconfigured", async () => {
      mockSend.mockResolvedValue({});
      expect(await getTenant(TENANT)).toBeNull();
    });

    test("is eventually consistent unless asked otherwise", async () => {
      mockSend.mockResolvedValue({});
      await getTenant(TENANT);
      expect(mockSend.mock.calls[0][0].input).not.toHaveProperty("ConsistentRead");
    });

    test("reads strongly consistent when asked", async () => {
      mockSend.mockResolvedValue({});
      await getTenant(TENANT, { consistentRead: true });
      expect(mockSend.mock.calls[0][0].input.ConsistentRead).toBe(true);
    });
  });

  // upsertTenant is a read-modify-write that ends in a whole-item Put. On a
  // stale read it doesn't just miss a recent save, it overwrites it: saving
  // Hashnode's id could erase the Medium id saved a moment before.
  describe("upsertTenant read-modify-write", () => {
    test("reads the row strongly consistent before merging", async () => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({});
      await upsertTenant(TENANT, { platforms: { hashnode: { publicationId: "hp" } } });
      expect(mockSend.mock.calls[0][0].input.ConsistentRead).toBe(true);
    });

    test("keeps another platform's just-saved id when merging", async () => {
      mockSend
        .mockResolvedValueOnce({ Item: { ...tenantConfigKey(TENANT), platforms: { medium: { publicationId: "pm" } } } })
        .mockResolvedValueOnce({});

      const item = await upsertTenant(TENANT, { platforms: { hashnode: { publicationId: "hp" } } });

      expect(item.platforms).toEqual({ medium: { publicationId: "pm" }, hashnode: { publicationId: "hp" } });
      // What's returned is exactly what was Put, so callers can report on it.
      expect(mockSend.mock.calls[1][0].input.Item).toEqual(item);
    });
  });

  describe("upsertTenant", () => {
    test("creates a new config with TENANTS GSI keys and entity", async () => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({}); // get (none) + put
      const item = await upsertTenant(TENANT, { canonicalBaseUrl: "https://x.io", platforms: { dev: { organizationId: "2491" } } });

      expect(item.pk).toBe(`TENANT#${TENANT}`);
      expect(item.sk).toBe("#CONFIG");
      expect(item.entity).toBe("Tenant");
      expect(item.gsi1pk).toBe("TENANTS");
      expect(item.gsi1sk).toBe(TENANT);
      expect(item.canonicalBaseUrl).toBe("https://x.io");
      expect(item.platforms).toEqual({ dev: { organizationId: "2491" } });
      expect(item.createdAt).toBe(item.updatedAt);
    });

    test("preserves createdAt and deep-merges platforms on update", async () => {
      mockSend
        .mockResolvedValueOnce({
          Item: {
            ...tenantConfigKey(TENANT),
            entity: "Tenant",
            tenantId: TENANT,
            createdAt: "2026-01-01T00:00:00.000Z",
            platforms: { dev: { organizationId: "2491" }, medium: { publicationId: "med-1" } },
          },
        })
        .mockResolvedValueOnce({}); // put

      const item = await upsertTenant(TENANT, { platforms: { hashnode: { publicationId: "hn-1" } } });

      expect(item.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(item.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
      // existing platforms preserved, new one added
      expect(item.platforms).toEqual({
        dev: { organizationId: "2491" },
        medium: { publicationId: "med-1" },
        hashnode: { publicationId: "hn-1" },
      });
    });

    test("merges sub-fields within a platform without dropping siblings", async () => {
      mockSend
        .mockResolvedValueOnce({ Item: { createdAt: "2026-01-01T00:00:00.000Z", platforms: { hashnode: { publicationId: "hn-1" } } } })
        .mockResolvedValueOnce({});

      const item = await upsertTenant(TENANT, { platforms: { hashnode: { blogUrl: "https://h.dev" } } });

      expect(item.platforms.hashnode).toEqual({ publicationId: "hn-1", blogUrl: "https://h.dev" });
    });
  });

  describe("listTenants", () => {
    test("queries the TENANTS GSI bucket", async () => {
      mockSend.mockResolvedValue({ Items: [{ tenantId: TENANT }], LastEvaluatedKey: { pk: "x" } });
      const result = await listTenants({ limit: 50 });

      const input = mockSend.mock.calls[0][0].input;
      expect(input.IndexName).toBe("GSI1");
      expect(input.ExpressionAttributeValues[":pk"]).toBe("TENANTS");
      expect(result.items).toEqual([{ tenantId: TENANT }]);
      expect(result.lastEvaluatedKey).toEqual({ pk: "x" });
    });
  });
});
