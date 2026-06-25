import {
  createContent,
  deleteContent,
  getContent,
  listContentByTenant,
  updateContent,
} from "../domain/content.mjs";
import { requireTenantId } from "../services/identity.mjs";
import { withIdempotency } from "../services/idempotency.mjs";
import { decodeCursor, encodeCursor, parseLimit } from "../services/pagination.mjs";
import { emptyResponse, jsonResponse } from "../services/http-handler.mjs";
import { BadRequestError } from "../services/errors.mjs";
import { embedText } from "../services/embeddings.mjs";
import { queryContentChunks } from "../services/content-vectors.mjs";
import { answerContentQuestion } from "../services/bedrock.mjs";
import {
  formatContent,
  formatContentAnswer,
  formatContentSummary,
  validateContentCreate,
  validateContentQuestion,
  validateContentUpdate,
} from "../validation/content.mjs";

// Content catalog CRUD. Every route resolves the tenant from the authorizer
// sub (requireTenantId) and passes it as the first argument to the domain,
// so reads/writes are confined to the caller's TENANT#{sub} partition.

export function registerContentRoutes(app) {
  app.post("/content", withIdempotency(async ({ event }) => {
    const tenantId = requireTenantId(event);
    const fields = validateContentCreate(parseBody(event));
    const item = await createContent(tenantId, fields);
    return jsonResponse(201, formatContent(item));
  }));

  // POST /content/ask — RAG Q&A over the tenant's content catalog. Embeds the
  // question, retrieves the nearest chunks from the vector index (tenant-
  // scoped, optionally one piece or one type), and asks Bedrock to answer
  // grounded in them. Registered before /content/:contentId so the literal
  // path wins. Nothing is persisted; a retry just re-runs.
  app.post("/content/ask", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const { question, topK, contentId, type } = validateContentQuestion(parseBody(event));

    const queryEmbedding = await embedText(question);
    const chunks = await queryContentChunks({ tenantId, queryEmbedding, topK, contentId, type });

    // No vectors matched (empty catalog or nothing relevant): answer plainly
    // without spending a Bedrock call.
    if (chunks.length === 0) {
      return jsonResponse(200, formatContentAnswer({
        answer: "I couldn't find anything in your content catalog relevant to that question.",
        confidence: "low",
        citations: [],
      }));
    }

    const { answer, sources_used, confidence } = await answerContentQuestion({ question, chunks });
    return jsonResponse(200, formatContentAnswer({
      answer,
      confidence: confidence ?? "low",
      citations: resolveCitations(sources_used, chunks),
    }));
  });

  app.get("/content", async ({ event }) => {
    const tenantId = requireTenantId(event);
    const qs = event.queryStringParameters ?? {};

    const limit = parseLimit(qs.limit);
    const exclusiveStartKey = decodeCursor(qs.startKey);
    const { items, lastEvaluatedKey } = await listContentByTenant(tenantId, {
      limit,
      exclusiveStartKey,
      type: qs.type,
      source: qs.source,
      status: qs.status,
    });
    return jsonResponse(200, {
      content: items.map(formatContentSummary),
      nextStartKey: encodeCursor(lastEvaluatedKey),
    });
  });

  app.get("/content/:contentId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const content = await getContent(tenantId, params.contentId);
    return jsonResponse(200, formatContent(content));
  });

  app.patch("/content/:contentId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    const fields = validateContentUpdate(parseBody(event));
    if (Object.keys(fields).length === 0) {
      throw new BadRequestError("request body must contain at least one updatable field");
    }
    const updated = await updateContent(tenantId, params.contentId, fields);
    return jsonResponse(200, formatContent(updated));
  });

  app.delete("/content/:contentId", async ({ event, params }) => {
    const tenantId = requireTenantId(event);
    await deleteContent(tenantId, params.contentId);
    return emptyResponse(204);
  });
}

// Maps the model's 1-based source_used numbers back to the pieces they point
// at, deduped to one citation per piece of content (the same piece can
// contribute several chunks). Out-of-range numbers are ignored so a stray
// index can't crash the response.
function resolveCitations(sourcesUsed, chunks) {
  const seen = new Set();
  const citations = [];
  for (const n of sourcesUsed ?? []) {
    const chunk = chunks[n - 1];
    if (!chunk || !chunk.contentId || seen.has(chunk.contentId)) continue;
    seen.add(chunk.contentId);
    citations.push({ contentId: chunk.contentId, title: chunk.title, slug: chunk.slug, type: chunk.type });
  }
  return citations;
}

function parseBody(event) {
  if (!event.body) {
    throw new BadRequestError("Missing request body");
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}
