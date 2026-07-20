/* global awslambda */
// `awslambda` is a global provided by the Lambda Node runtime for response
// streaming (streamifyResponse / HttpResponseStream); it has no import.
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { getContent } from "../../api/domain/content.mjs";
import { createReview } from "../../api/domain/content-review.mjs";
import { formatReview } from "../../api/validation/content-review.mjs";
import { runReview } from "../../api/services/review-runner.mjs";
import { logger } from "../../api/services/logger.mjs";

// Response-streaming Lambda behind a Function URL (InvokeMode RESPONSE_STREAM):
// the LIVE content review path. The REST API can't stream, so a client that
// wants live progress calls this instead of POST /content/{id}/reviews + poll.
// It creates the review, runs the shared review engine, and streams each lens's
// progress and the recorded suggestions to the client as they land — no Momento,
// just NDJSON over the response stream. It is NOT behind API Gateway's Cognito
// authorizer, so it verifies the same id token in-process (same pool/client as
// authorizer.mjs) and scopes everything to that sub.
//
// Wire protocol (see review-runner.mjs for the full contract): NDJSON events —
//   {"type":"review","review":{…}}          the created review (carries its id)
//   {"type":"status","lens":"…","state":"running"}
//   {"type":"lens","name":"…","count":n}
//   {"type":"suggestions","suggestions":[…]} the recorded, anchored set
//   {"type":"summary","summary":"…","verdict":"…"}
//   {"type":"done","status":"succeeded"} | {"type":"error","message":"…"}

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID,
  tokenUse: "id",
  clientId: process.env.USER_POOL_CLIENT_ID,
});

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  // Verify auth + validate + create the review BEFORE committing a 200 stream,
  // so genuine 401/400/404s aren't masked as a successful stream.
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

  let content;
  try {
    content = await getContent(sub, request.contentId);
  } catch {
    return fail(responseStream, 404, "Content not found");
  }
  if (!content.contentMarkdown || content.contentMarkdown.trim().length === 0) {
    return fail(responseStream, 400, "content has no body to review");
  }

  const review = await createReview(sub, request.contentId, { contentVersion: content.updatedAt });

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
  const write = (obj) => stream.write(`${JSON.stringify(obj)}\n`);

  try {
    write({ type: "review", review: formatReview(review) });
    await runReview({
      tenantId: sub,
      contentId: request.contentId,
      reviewId: review.reviewId,
      contentVersion: content.updatedAt,
      platform: request.platform,
      emit: write,
    });
  } catch (err) {
    // runReview already emitted a terminal error event and marked the review
    // failed; just log. The stream is closed in finally.
    logger.error("stream-review failed mid-stream", { error: err?.message });
  } finally {
    stream.end();
  }
});

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
  if (typeof body.contentId !== "string" || body.contentId.length === 0) {
    throw new Error("contentId is required");
  }
  const platform = typeof body.platform === "string" && body.platform.trim() ? body.platform.trim() : undefined;
  return { contentId: body.contentId, platform };
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
