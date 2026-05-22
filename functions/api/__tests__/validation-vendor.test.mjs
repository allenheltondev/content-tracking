import { validateVendorPayload } from "../validation/vendor.mjs";
import { BadRequestError } from "../services/errors.mjs";

describe("validateVendorPayload", () => {
  describe("with requireName", () => {
    const opts = { requireName: true };

    test("rejects non-object body", () => {
      expect(() => validateVendorPayload(null, opts)).toThrow(BadRequestError);
      expect(() => validateVendorPayload([], opts)).toThrow(BadRequestError);
    });

    test("requires non-empty name", () => {
      expect(() => validateVendorPayload({}, opts)).toThrow(/name is required/);
      expect(() => validateVendorPayload({ name: "  " }, opts)).toThrow(/non-empty/);
    });

    test("rejects malformed email", () => {
      expect(() => validateVendorPayload({ name: "x", contact_email: "not-an-email" }, opts)).toThrow(/email/);
    });

    test("rejects website missing scheme", () => {
      expect(() => validateVendorPayload({ name: "x", website: "acme.com" }, opts)).toThrow(/http/);
    });

    test("rejects tags not an array", () => {
      expect(() => validateVendorPayload({ name: "x", tags: "tag1,tag2" }, opts)).toThrow();
    });

    test("rejects tag too long", () => {
      expect(() => validateVendorPayload({ name: "x", tags: ["x".repeat(51)] }, opts)).toThrow();
    });

    test("happy path with all fields", () => {
      const out = validateVendorPayload({
        name: "AcmeCorp",
        website: "https://acme.com",
        contact_name: "Alex",
        contact_email: "alex@acme.com",
        payment_terms: "net 30",
        tags: ["partner", "saas"],
        notes: "preferred Q4",
      }, opts);
      expect(out.name).toBe("AcmeCorp");
      expect(out.tags).toEqual(["partner", "saas"]);
    });
  });

  describe("partial update (requireName false)", () => {
    const opts = { requireName: false };

    test("allows empty payload", () => {
      expect(validateVendorPayload({}, opts)).toEqual({});
    });

    test("forwards null for clearable fields", () => {
      const out = validateVendorPayload({
        contact_email: null,
        notes: null,
      }, opts);
      expect(out.contact_email).toBeNull();
      expect(out.notes).toBeNull();
    });
  });
});
