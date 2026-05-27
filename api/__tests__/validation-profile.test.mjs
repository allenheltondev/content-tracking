import { validateProfileUpdate } from "../validation/profile.mjs";
import { BadRequestError } from "../services/errors.mjs";

const SERVICE_ACCOUNT = {
  type: "service_account",
  client_email: "booked@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n",
};

describe("validateProfileUpdate", () => {
  test("rejects non-object body", () => {
    expect(() => validateProfileUpdate(null)).toThrow(BadRequestError);
    expect(() => validateProfileUpdate([])).toThrow(BadRequestError);
  });

  test("empty body is a valid no-op", () => {
    expect(validateProfileUpdate({})).toEqual({});
  });

  test("validates ga4_property_id is numeric", () => {
    expect(validateProfileUpdate({ ga4_property_id: "123456789" }).ga4PropertyId).toBe("123456789");
    expect(() => validateProfileUpdate({ ga4_property_id: "G-ABC123" })).toThrow(/numeric GA4 property/);
  });

  test("treats empty ga4_property_id as omitted", () => {
    expect(validateProfileUpdate({ ga4_property_id: "" })).toEqual({});
  });

  test("accepts a service account object", () => {
    const out = validateProfileUpdate({ ga4_service_account: SERVICE_ACCOUNT });
    expect(out.ga4ServiceAccount.client_email).toBe(SERVICE_ACCOUNT.client_email);
  });

  test("accepts a service account pasted as a JSON string", () => {
    const out = validateProfileUpdate({ ga4_service_account: JSON.stringify(SERVICE_ACCOUNT) });
    expect(out.ga4ServiceAccount.private_key).toContain("PRIVATE KEY");
  });

  test("rejects a service account missing required fields", () => {
    expect(() => validateProfileUpdate({ ga4_service_account: { client_email: "x@y.z" } }))
      .toThrow(/private_key/);
    expect(() => validateProfileUpdate({ ga4_service_account: { private_key: "BEGIN PRIVATE KEY" } }))
      .toThrow(/client_email/);
    expect(() => validateProfileUpdate({ ga4_service_account: "not json" })).toThrow(/valid JSON/);
  });

  test("accepts and trims a crux_api_key", () => {
    expect(validateProfileUpdate({ crux_api_key: "  AIzaKey  " }).cruxApiKey).toBe("AIzaKey");
  });

  test("collects multiple fields together", () => {
    const out = validateProfileUpdate({
      ga4_property_id: "987654321",
      ga4_service_account: SERVICE_ACCOUNT,
      crux_api_key: "AIzaKey",
    });
    expect(out.ga4PropertyId).toBe("987654321");
    expect(out.cruxApiKey).toBe("AIzaKey");
    expect(out.ga4ServiceAccount.client_email).toBe(SERVICE_ACCOUNT.client_email);
  });
});
