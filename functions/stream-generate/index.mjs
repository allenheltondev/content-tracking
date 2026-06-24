/* global awslambda */
// `awslambda` is a global provided by the Lambda Node runtime for response
// streaming (streamifyResponse / HttpResponseStream); it has no import.
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { embedText } from "../../api/services/embeddings.mjs";
import { queryVoiceSamples } from "../../api/services/voice-vectors.mjs";
import { queryBlogChunks } from "../../api/services/blog-vectors.mjs";
import { getVoiceProfile } from "../../api/domain/voice.mjs";
import { streamVoicePost, streamBlogAnswer } from "../../api/services/bedrock-stream.mjs";
import { validateComposeRequest } from "../../api/validation/voice.mjs";
import { validateBlogQuestion } from "../../api/validation/blog.mjs";
import { logger } from "../../api/services/logger.mjs";

// Response-streaming Lambda behind a Function URL (InvokeMode RESPONSE_STREAM).
// The REST API (API Gateway) can't stream, so this is the live-typing path for
// POST /voice/compose and /blogs/ask. It is NOT behind the API's Cognito
// authorizer, so it verifies the same id token in-process (same user pool +
// client as authorizer.mjs) and scopes all reads to that sub's partition.
//
// Wire protocol: newline-delimited JSON events written to the stream —
//   {"type":"delta","text":"…"}   incremental model output
//   {"type":"done","sources":[…]} terminal (sources only for ask)
//   {"type":"error","message":"…"} terminal failure

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID,
  tokenUse: "id",
  clientId: process.env.USER_POOL_CLIENT_ID,
});

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // Verify auth and validate the request BEFORE committing a response status,
  // so genuine 401/400s aren't masked as a 200 stream.
  let sub;
  let request;
  try {
    sub = await authenticate(event);
  } catch {
    return fail(responseStream, 401, "Unauthorized");
  }
  try {
    request = parseRequest(event);
  } catch (err) {
    return fail(responseStream, 400, err?.message ?? "Bad request");
  }

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
  const write = (obj) => stream.write(`${JSON.stringify(obj)}\n`);

  try {
    if (request.mode === "compose") {
      await runCompose(sub, request, write);
    } else {
      await runAsk(sub, request, write);
    }
  } catch (err) {
    logger.error("stream-generate failed mid-stream", { mode: request.mode, error: err?.message });
    write({ type: "error", message: err?.message ?? "Generation failed" });
  } finally {
    stream.end();
  }
});

async function runCompose(sub, { params }, write) {
  const { topic, platform, format, guidance } = params;
  const queryEmbedding = await embedText(topic);
  const [samples, profileRow] = await Promise.all([
    queryVoiceSamples({ tenantId: sub, queryEmbedding, platform }),
    getVoiceProfile(sub, platform),
  ]);
  for await (const text of streamVoicePost({
    topic, platform, format, profile: profileRow?.profile ?? null, samples, guidance,
  })) {
    write({ type: "delta", text });
  }
  write({ type: "done" });
}

async function runAsk(sub, { params }, write) {
  const { question, topK, blogId } = params;
  const queryEmbedding = await embedText(question);
  const chunks = await queryBlogChunks({ tenantId: sub, queryEmbedding, topK, blogId });

  if (chunks.length === 0) {
    write({ type: "delta", text: "I couldn't find anything in your blog catalog relevant to that question." });
    write({ type: "done", sources: [] });
    return;
  }

  for await (const text of streamBlogAnswer({ question, chunks })) {
    write({ type: "delta", text });
  }
  write({ type: "done", sources: dedupeSources(chunks) });
}

// One citation per blog (a post can contribute several chunks). The streamed
// answer carries no tool output, so sources come from what retrieval surfaced.
function dedupeSources(chunks) {
  const seen = new Set();
  const sources = [];
  for (const c of chunks) {
    if (!c.blogId || seen.has(c.blogId)) continue;
    seen.add(c.blogId);
    sources.push({ blog_id: c.blogId, title: c.title ?? null, slug: c.slug ?? null });
  }
  return sources;
}

async function authenticate(event) {
  const header = event.headers?.authorization ?? event.headers?.Authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (!token) throw new Error("missing token");
  const payload = await verifier.verify(token);
  return payload.sub;
}

function parseRequest(event) {
  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
  if (body.mode === "compose") {
    return { mode: "compose", params: validateComposeRequest(body) };
  }
  if (body.mode === "ask") {
    return { mode: "ask", params: validateBlogQuestion(body) };
  }
  throw new Error('mode must be "compose" or "ask"');
}

// Terminal error with a real HTTP status (used before the stream is committed).
function fail(responseStream, statusCode, message) {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: { "content-type": "application/x-ndjson" },
  });
  stream.write(`${JSON.stringify({ type: "error", message })}\n`);
  stream.end();
}
