import { describeCrosspostReadiness } from "../services/crosspost-readiness.mjs";

const FULL_TENANT = {
  platforms: {
    dev: { organizationId: "42" },
    medium: { publicationId: "pub-m" },
    hashnode: { publicationId: "pub-h", blogUrl: "https://me.hashnode.dev" },
  },
};
const FULL_CREDS = { dev: "d", medium: "m", hashnode: "h" };

describe("describeCrosspostReadiness", () => {
  test("a fresh tenant with nothing configured is not ready anywhere", () => {
    const { platforms } = describeCrosspostReadiness(null, null);

    expect(platforms.dev).toEqual({ ready: false, token_configured: false, missing: ["token"], organization_id: null });
    expect(platforms.medium).toEqual({ ready: false, token_configured: false, missing: ["token", "publication_id"], publication_id: null });
    expect(platforms.hashnode).toEqual({
      ready: false, token_configured: false, missing: ["token", "publication_id"], publication_id: null, blog_url: null,
    });
  });

  test("everything configured is ready everywhere", () => {
    const { platforms } = describeCrosspostReadiness(FULL_TENANT, FULL_CREDS);
    for (const p of ["dev", "medium", "hashnode"]) {
      expect(platforms[p].ready).toBe(true);
      expect(platforms[p].missing).toEqual([]);
    }
    expect(platforms.dev.organization_id).toBe("42");
    expect(platforms.hashnode.blog_url).toBe("https://me.hashnode.dev");
  });

  // The whole reason readiness isn't just "is there a token": the Medium and
  // Hashnode adapters throw without a publication id. Calling that "set up"
  // would send the author into a cross-post that fails.
  test("a token alone does not make Medium or Hashnode ready", () => {
    const { platforms } = describeCrosspostReadiness(null, FULL_CREDS);

    expect(platforms.dev.ready).toBe(true); // dev.to needs nothing else
    expect(platforms.medium).toMatchObject({ ready: false, token_configured: true, missing: ["publication_id"] });
    expect(platforms.hashnode).toMatchObject({ ready: false, token_configured: true, missing: ["publication_id"] });
  });

  test("a publication id without a token is missing just the token", () => {
    const { platforms } = describeCrosspostReadiness(FULL_TENANT, {});
    expect(platforms.medium).toMatchObject({ ready: false, token_configured: false, missing: ["token"], publication_id: "pub-m" });
  });

  test("blank strings count as missing", () => {
    const { platforms } = describeCrosspostReadiness(
      { platforms: { medium: { publicationId: "   " } } },
      { medium: "  " },
    );
    expect(platforms.medium.missing).toEqual(["token", "publication_id"]);
  });

  // The report is the only thing the settings endpoint returns. It must never
  // carry a token, not even under an innocent-looking key.
  test("never includes a token value", () => {
    const secret = "super-secret-token-value";
    const report = describeCrosspostReadiness(FULL_TENANT, { dev: secret, medium: secret, hashnode: secret });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  test("the Medium stats cookie does not make Medium ready", () => {
    const { platforms } = describeCrosspostReadiness(FULL_TENANT, { "medium-cookie": "c" });
    expect(platforms.medium.token_configured).toBe(false);
  });
});
