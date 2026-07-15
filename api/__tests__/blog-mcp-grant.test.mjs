import { signBlogGrant, verifyBlogGrant, BLOG_GRANT_HEADER } from "../services/blog-mcp-grant.mjs";

const SECRET = "test-secret-at-least-32-characters-long!!";

describe("blog-mcp-grant", () => {
  test("round-trips sub, ver, and iat", () => {
    const token = signBlogGrant({ sub: "user-1", secret: SECRET, version: 3, issuedAt: 1700000000 });
    const claims = verifyBlogGrant(token, SECRET);
    expect(claims).toEqual({ sub: "user-1", ver: 3, iat: 1700000000 });
  });

  test("defaults version to 1 and stamps iat when omitted", () => {
    const token = signBlogGrant({ sub: "user-1", secret: SECRET });
    const claims = verifyBlogGrant(token, SECRET);
    expect(claims.ver).toBe(1);
    expect(typeof claims.iat).toBe("number");
  });

  test("rejects a grant signed with a different secret", () => {
    const token = signBlogGrant({ sub: "user-1", secret: SECRET });
    expect(() => verifyBlogGrant(token, "another-secret-of-sufficient-length!!")).toThrow(/Signature mismatch/);
  });

  test("rejects a tampered payload", () => {
    const token = signBlogGrant({ sub: "user-1", secret: SECRET });
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "attacker", ver: 1, iat: 1 }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => verifyBlogGrant(`${header}.${forgedPayload}.${signature}`, SECRET)).toThrow(/Signature mismatch/);
  });

  test("rejects a malformed token", () => {
    expect(() => verifyBlogGrant("not.a.valid.token", SECRET)).toThrow(/Malformed grant/);
  });

  test("requires sub and secret to sign", () => {
    expect(() => signBlogGrant({ secret: SECRET })).toThrow(/requires sub and secret/);
    expect(() => signBlogGrant({ sub: "user-1" })).toThrow(/requires sub and secret/);
  });

  test("exposes the forwarding header name", () => {
    expect(BLOG_GRANT_HEADER).toBe("x-booked-agent-auth");
  });
});
