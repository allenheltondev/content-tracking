import { validateTenantConfig, formatTenant } from "../validation/tenant.mjs";

describe("validation/tenant", () => {
  describe("validateTenantConfig", () => {
    test("accepts a full config and maps to camelCase", () => {
      const out = validateTenantConfig({
        canonical_base_url: "https://readysetcloud.io",
        admin_email: "me@example.com",
        platforms: {
          dev: { organization_id: 2491 },
          medium: { publication_id: "5517fd7b58a6" },
          hashnode: { publication_id: "626beb20", blog_url: "https://h.hashnode.dev" },
        },
      });

      expect(out).toEqual({
        canonicalBaseUrl: "https://readysetcloud.io",
        adminEmail: "me@example.com",
        platforms: {
          dev: { organizationId: "2491" }, // numeric id normalized to string
          medium: { publicationId: "5517fd7b58a6" },
          hashnode: { publicationId: "626beb20", blogUrl: "https://h.hashnode.dev" },
        },
      });
    });

    test("allows partial config (single field)", () => {
      expect(validateTenantConfig({ admin_email: "x@y.co" })).toEqual({ adminEmail: "x@y.co" });
    });

    test("rejects an empty body", () => {
      expect(() => validateTenantConfig({})).toThrow(/at least one of/);
    });

    test("rejects a non-object body", () => {
      expect(() => validateTenantConfig(null)).toThrow(/must be a JSON object/);
      expect(() => validateTenantConfig([])).toThrow(/must be a JSON object/);
    });

    test("rejects a bad canonical_base_url", () => {
      expect(() => validateTenantConfig({ canonical_base_url: "readysetcloud.io" })).toThrow(/http/);
    });

    test("rejects a bad admin_email", () => {
      expect(() => validateTenantConfig({ admin_email: "nope" })).toThrow(/email/);
    });

    test("rejects an unknown platform", () => {
      expect(() => validateTenantConfig({ platforms: { substack: { publication_id: "x" } } })).toThrow(/unknown platform/);
    });

    test("rejects a bad hashnode blog_url", () => {
      expect(() => validateTenantConfig({ platforms: { hashnode: { blog_url: "h.dev" } } })).toThrow(/http/);
    });

    test("allows clearing top-level fields with null", () => {
      expect(validateTenantConfig({ canonical_base_url: null, admin_email: null })).toEqual({
        canonicalBaseUrl: null,
        adminEmail: null,
      });
    });
  });

  describe("formatTenant", () => {
    test("returns an unconfigured shape for null", () => {
      const out = formatTenant(null);
      expect(out.configured).toBe(false);
      expect(out.canonical_base_url).toBeNull();
      expect(out.platforms.hashnode).toEqual({ publication_id: null, blog_url: null });
    });

    test("maps a stored row back to snake_case", () => {
      const out = formatTenant({
        canonicalBaseUrl: "https://x.io",
        adminEmail: "a@b.co",
        platforms: { dev: { organizationId: "2491" }, hashnode: { publicationId: "hn", blogUrl: "https://h.dev" } },
        createdAt: "t0",
        updatedAt: "t1",
      });

      expect(out.configured).toBe(true);
      expect(out.canonical_base_url).toBe("https://x.io");
      expect(out.platforms.dev.organization_id).toBe("2491");
      expect(out.platforms.medium.publication_id).toBeNull();
      expect(out.platforms.hashnode).toEqual({ publication_id: "hn", blog_url: "https://h.dev" });
      expect(out.created_at).toBe("t0");
    });
  });
});
