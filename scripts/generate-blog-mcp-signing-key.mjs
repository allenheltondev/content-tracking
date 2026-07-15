// Prints a random 64-character base64url string suitable for the
// BLOG_MCP_SIGNING_KEY GitHub secret. This signs the "Ask your blog" grant
// that authenticates the shared runtime's call into Booked's blog-search MCP
// server. Run once per environment when turning grounding on, paste the output
// into the Staging / Production GitHub environment's Secrets, then set the
// BLOG_MCP_URL variable to the deployed MCP endpoint.
//
// Usage: node scripts/generate-blog-mcp-signing-key.mjs

import { randomBytes } from "node:crypto";

const key = randomBytes(48)
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

console.log(key);
