import { validateCrosspostSettings } from "../validation/crosspost-settings.mjs";

describe("validateCrosspostSettings", () => {
  test("splits tokens (SSM) from ids (tenant row)", () => {
    const out = validateCrosspostSettings({
      platforms: {
        dev: { token: " dev-key ", organization_id: 123 },
        medium: { token: "m", publication_id: "pub" },
        hashnode: { publication_id: "hp", blog_url: "https://me.hashnode.dev" },
      },
    });

    expect(out.credentials).toEqual({ dev: "dev-key", medium: "m" });
    expect(out.config).toEqual({
      dev: { organizationId: "123" },
      medium: { publicationId: "pub" },
      hashnode: { publicationId: "hp", blogUrl: "https://me.hashnode.dev" },
    });
  });

  // Omitted leaves it alone, null clears it. That split is what lets
  // "Disconnect" drop a token while keeping the publication id.
  test("null clears; omitted is untouched", () => {
    const out = validateCrosspostSettings({ platforms: { medium: { token: null } } });
    expect(out.credentials).toEqual({ medium: null });
    expect(out.config).toEqual({});
  });

  test("an id can be cleared with null", () => {
    const out = validateCrosspostSettings({ platforms: { hashnode: { publication_id: null, blog_url: null } } });
    expect(out.config).toEqual({ hashnode: { publicationId: null, blogUrl: null } });
  });

  // An empty string is almost always an untouched input. Clearing a credential
  // should take a deliberate null, never a side effect of saving a blank field.
  test("an empty token is rejected rather than treated as a clear", () => {
    expect(() => validateCrosspostSettings({ platforms: { dev: { token: "   " } } })).toThrow(/null to clear/);
  });

  test("rejects unknown platforms and unknown fields", () => {
    expect(() => validateCrosspostSettings({ platforms: { substack: { token: "x" } } })).toThrow(/unknown platform "substack"/);
    // dev.to has no publication; a typo'd field must not be silently dropped.
    expect(() => validateCrosspostSettings({ platforms: { dev: { publication_id: "x" } } })).toThrow(/not a recognized field/);
  });

  // Saving "abc" used to succeed and report DEV as ready, then fail at
  // dev.to on the next cross-post, because the adapter sends Number() of it.
  test("rejects a non-numeric dev.to organization id", () => {
    expect(() => validateCrosspostSettings({ platforms: { dev: { organization_id: "abc" } } }))
      .toThrow(/platforms\.dev\.organization_id must be a positive whole number/);
    expect(() => validateCrosspostSettings({ platforms: { dev: { organization_id: "12.5" } } }))
      .toThrow(/positive whole number/);
  });

  test("accepts a numeric-string organization id and still clears with null", () => {
    expect(validateCrosspostSettings({ platforms: { dev: { organization_id: "2491" } } }).config)
      .toEqual({ dev: { organizationId: "2491" } });
    expect(validateCrosspostSettings({ platforms: { dev: { organization_id: null } } }).config)
      .toEqual({ dev: { organizationId: null } });
  });

  test("rejects a non-http blog url", () => {
    expect(() => validateCrosspostSettings({ platforms: { hashnode: { blog_url: "me.hashnode.dev" } } })).toThrow(/http\(s\) URL/);
  });

  test("rejects a body that changes nothing", () => {
    expect(() => validateCrosspostSettings({ platforms: {} })).toThrow(/at least one field/);
    expect(() => validateCrosspostSettings({ platforms: { dev: {} } })).toThrow(/at least one field/);
  });

  test("rejects malformed bodies", () => {
    expect(() => validateCrosspostSettings(null)).toThrow(/JSON object/);
    expect(() => validateCrosspostSettings({ platforms: [] })).toThrow(/platforms must be/);
    expect(() => validateCrosspostSettings({ platforms: { dev: "k" } })).toThrow(/platforms.dev must be/);
  });
});
