import { signToken, verifyToken, newJti, TOKEN_KID } from "../services/extension-token.mjs";

const SECRET = "test-signing-secret-32-chars-long-xx";
const SUB = "abc-123-cognito-sub";

describe("services/extension-token", () => {
  describe("signToken + verifyToken", () => {
    test("round-trips sub, jti, and iat", () => {
      const jti = newJti();
      const issuedAt = 1700000000;
      const token = signToken({ sub: SUB, jti, secret: SECRET, issuedAt });
      const decoded = verifyToken(token, SECRET);
      expect(decoded).toEqual({ sub: SUB, jti, iat: issuedAt });
    });

    test("defaults iat to now when not supplied", () => {
      const before = Math.floor(Date.now() / 1000);
      const token = signToken({ sub: SUB, jti: newJti(), secret: SECRET });
      const after = Math.floor(Date.now() / 1000);
      const decoded = verifyToken(token, SECRET);
      expect(decoded.iat).toBeGreaterThanOrEqual(before);
      expect(decoded.iat).toBeLessThanOrEqual(after);
    });

    test("encodes the kid in the header for future rotation", () => {
      const token = signToken({ sub: SUB, jti: newJti(), secret: SECRET });
      const headerJson = Buffer.from(token.split(".")[0], "base64").toString("utf8");
      const header = JSON.parse(headerJson);
      expect(header.alg).toBe("HS256");
      expect(header.kid).toBe(TOKEN_KID);
    });

    test("rejects a token signed with a different secret", () => {
      const token = signToken({ sub: SUB, jti: newJti(), secret: SECRET });
      expect(() => verifyToken(token, "different-secret")).toThrow(/Signature mismatch/);
    });

    test("rejects a tampered payload", () => {
      const token = signToken({ sub: SUB, jti: newJti(), secret: SECRET });
      const [h, , s] = token.split(".");
      // Re-encode a payload with a different sub but keep the original
      // signature; verify should reject.
      const evilPayload = Buffer.from(JSON.stringify({ sub: "evil", jti: "x", iat: 1 }))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      expect(() => verifyToken(`${h}.${evilPayload}.${s}`, SECRET)).toThrow(/Signature mismatch/);
    });

    test("rejects a token with too few segments", () => {
      expect(() => verifyToken("not.a-jwt", SECRET)).toThrow(/expected 3 segments/);
    });

    test("rejects an empty token", () => {
      expect(() => verifyToken("", SECRET)).toThrow();
    });

    test("requires sub, jti, and secret on sign", () => {
      expect(() => signToken({ sub: "x", jti: "y" })).toThrow(/requires sub, jti, and secret/);
      expect(() => signToken({ sub: "x", secret: SECRET })).toThrow(/requires sub, jti, and secret/);
      expect(() => signToken({ jti: "y", secret: SECRET })).toThrow(/requires sub, jti, and secret/);
    });
  });

  describe("newJti", () => {
    test("returns a url-safe base64 string of 22 chars", () => {
      const jti = newJti();
      expect(jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });

    test("returns a fresh value each call", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(newJti());
      expect(ids.size).toBe(100);
    });
  });
});
