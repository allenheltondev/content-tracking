import { createHmac } from "node:crypto";
import { verifyAuthToken } from "./auth.mjs";

const SECRET = "test-secret";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Mint a token the same way Booked's session-creation authority will (Phase 2).
const mint = (payload, secret = SECRET) => {
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", secret).update(p).digest());
  return `${p}.${sig}`;
};

const opts = { secret: SECRET, versions: ["1"] };

describe("verifyAuthToken", () => {
  test("accepts a valid token and returns the payload", () => {
    const token = mint({ sub: "user-1", sessionId: "s1", version: "1", iat: 5 });
    expect(verifyAuthToken(token, opts)).toMatchObject({ sub: "user-1", sessionId: "s1", version: "1" });
  });

  test("rejects a tampered payload (signature no longer matches)", () => {
    const token = mint({ sub: "user-1", version: "1" });
    const [, sig] = token.split(".");
    const forged = `${b64url(JSON.stringify({ sub: "attacker", version: "1" }))}.${sig}`;
    expect(verifyAuthToken(forged, opts)).toBeNull();
  });

  test("rejects a token signed with a different secret", () => {
    const token = mint({ sub: "user-1", version: "1" }, "other-secret");
    expect(verifyAuthToken(token, opts)).toBeNull();
  });

  test("rejects a version not in the accepted set (revocation)", () => {
    const token = mint({ sub: "user-1", version: "0" });
    expect(verifyAuthToken(token, opts)).toBeNull();
  });

  test("rejects malformed, missing-sub, empty, and secretless inputs", () => {
    expect(verifyAuthToken("no-dot", opts)).toBeNull();
    expect(verifyAuthToken(mint({ version: "1" }), opts)).toBeNull(); // no sub
    expect(verifyAuthToken("", opts)).toBeNull();
    expect(verifyAuthToken(null, opts)).toBeNull();
    expect(verifyAuthToken(mint({ sub: "u", version: "1" }), { secret: "", versions: ["1"] })).toBeNull();
  });

  test("skips the version gate when no versions are configured", () => {
    const token = mint({ sub: "user-1", version: "99" });
    expect(verifyAuthToken(token, { secret: SECRET, versions: [] })).toMatchObject({ sub: "user-1" });
  });
});
