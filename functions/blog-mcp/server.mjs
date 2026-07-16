import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { embedText } from "../../api/services/embeddings.mjs";
import { queryContentChunks } from "../../api/services/content-vectors.mjs";
import { logger } from "../../api/services/logger.mjs";

// Builds a fresh MCP server exposing a single `search_blog` tool, scoped to one
// tenant. A new server is built per request with the verified `tenantId` captured
// in the tool closure, so retrieval can never cross tenants — the same isolation
// the app's own /blogs/ask path enforces, now exposed as an MCP tool the shared
// agent runtime can call to ground answers in the author's own content.

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;

/** Renders retrieved chunks into a compact, citable text block for the model. */
function formatChunks(chunks) {
  if (!chunks || chunks.length === 0) {
    return "No matching passages were found in the author's content.";
  }
  return chunks
    .map((c, i) => {
      const where = c.slug ? ` (/${c.slug})` : "";
      const title = c.title || "Untitled";
      return `[${i + 1}] ${title}${where}\n${c.text ?? ""}`.trim();
    })
    .join("\n\n");
}

/**
 * Returns an MCP server with `search_blog` bound to `tenantId`. Call once per
 * request. The tool embeds the query (Titan) and runs a tenant-scoped nearest-
 * neighbour search over the content vector index (`queryContentChunks`), then
 * returns the passages as text for the agent to ground and cite.
 */
export function buildServer(tenantId) {
  const server = new McpServer({ name: "booked-blog-search", version: "1.0.0" });

  server.registerTool(
    "search_blog",
    {
      title: "Search the author's blog",
      description:
        "Semantic search over the author's own published blog posts and content. " +
        "Use this to ground answers in what the author has actually written, and to " +
        "cite sources. Returns the most relevant passages with their title and slug.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Natural-language search query — usually the user's question."),
        topK: z
          .number()
          .int()
          .min(1)
          .max(MAX_TOP_K)
          .optional()
          .describe(`Max passages to return (default ${DEFAULT_TOP_K}).`),
        type: z
          .string()
          .optional()
          .describe('Optional content-type filter (e.g. "blog").'),
      },
    },
    async ({ query, topK, type }) => {
      try {
        const embedding = await embedText(query);
        const chunks = await queryContentChunks({
          tenantId,
          queryEmbedding: embedding,
          topK: topK ?? DEFAULT_TOP_K,
          type,
        });
        logger.info("search_blog served", { tenantId, results: chunks.length });
        return { content: [{ type: "text", text: formatChunks(chunks) }] };
      } catch (err) {
        logger.error("search_blog failed", { tenantId, error: err?.message });
        return {
          content: [{ type: "text", text: `search_blog failed: ${err?.message ?? "unknown error"}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
