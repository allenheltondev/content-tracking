// Prints a random 64-character base64url string suitable for the
// EXTENSION_TOKEN_SIGNING_KEY GitHub secret. Run once per environment
// when standing up a fresh stack, paste the output into the Staging /
// Production GitHub environment's Secrets.
//
// Usage: node scripts/generate-extension-signing-key.mjs

import { randomBytes } from "node:crypto";

const key = randomBytes(48)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

console.log(key);
