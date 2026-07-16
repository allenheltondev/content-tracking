import { jest } from "@jest/globals";
import { createHmac } from "node:crypto";

process.env.MCP_AUTH_SECRET = "test-secret";
process.env.MCP_AUTH_HEADER = "x-booked-auth";
process.env.MCP_AUTH_VERSIONS = "1";
process.env.VECTOR_BUCKET_NAME = "bucket";
process.env.CONTENT_VECTOR_INDEX_NAME = "index";
process.env.EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";

const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
const { S3VectorsClient } = await import("@aws-sdk/client-s3vectors");
const { handler } = await import("./index.mjs");

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const mint = (payload) => {
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac("sha256", process.env.MCP_AUTH_SECRET).update(p).digest());
  return `${p}.${sig}`;
};

const TOKEN = mint({ sub: "tenant-42", sessionId: "s1", version: "1" });

const rpc = (body, token = TOKEN) => ({
  version: "2.0",
  rawPath: "/",
  rawQueryString: "",
  requestContext: { http: { method: "POST" } },
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token ? { "x-booked-auth": token } : {}),
  },
  body: JSON.stringify(body),
  isBase64Encoded: false,
});

const encode = (obj) => new TextEncoder().encode(JSON.stringify(obj));

describe("blog-mcp handler", () => {
  let embedSend;
  let vectorSend;

  beforeEach(() => {
    jest.clearAllMocks();
    embedSend = jest.fn().mockResolvedValue({ body: encode({ embedding: [0.1, 0.2, 0.3] }) });
    vectorSend = jest.fn().mockResolvedValue({
      vectors: [
        {
          key: "c1#0",
          distance: 0.12,
          metadata: { contentId: "c1", type: "blog", title: "Deploying", slug: "deploying", chunkIndex: 0, text: "Use sam deploy." },
        },
      ],
    });
    BedrockRuntimeClient.prototype.send = embedSend;
    S3VectorsClient.prototype.send = vectorSend;
  });

  test("rejects a request with no auth token", async () => {
    const res = await handler(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, null));
    expect(res.statusCode).toBe(401);
  });

  test("search_blog embeds the query, scopes retrieval to the token's tenant, and returns passages", async () => {
    const res = await handler(rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_blog", arguments: { query: "how do I deploy?", topK: 5 } },
    }));

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    const text = payload.result.content[0].text;
    expect(text).toContain("Deploying");
    expect(text).toContain("/deploying");
    expect(text).toContain("Use sam deploy.");
    expect(payload.result.isError).toBeFalsy();

    // Embedded the query (Titan) once.
    expect(embedSend).toHaveBeenCalledTimes(1);

    // Retrieval was scoped to the VERIFIED tenant (sub), never a client value.
    expect(vectorSend).toHaveBeenCalledTimes(1);
    const queryInput = vectorSend.mock.calls[0][0].input;
    expect(JSON.stringify(queryInput.filter)).toContain("tenant-42");
    expect(queryInput.topK).toBe(5);
  });

  test("surfaces a retrieval failure as an MCP tool error, not a 500", async () => {
    vectorSend.mockRejectedValueOnce(new Error("s3vectors down"));
    const res = await handler(rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search_blog", arguments: { query: "x" } },
    }));
    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0].text).toContain("search_blog failed");
  });
});
