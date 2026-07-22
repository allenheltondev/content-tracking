import { logger } from "./logger.mjs";
import { ApiError, BadRequestError } from "./errors.mjs";

// Wraps a Powertools Router with the conventions every route in this
// service shares: JSON responses, CORS headers, correlation IDs, and
// uniform error → status code mapping.
//
// Ported from olivias-garden-foundation's services/okra-api/src/services/
// http-handler.mjs, adapted to this stack (no tenant-routing, no auth
// extraction — API Gateway's Cognito authorizer handled that already).

// Origin is injected by the SAM template from the dashboard URL (custom
// domain when set, else the CloudFront hostname). Falls back to "*" only
// for local invocations where the env var isn't populated.
const CORS_HEADERS = {
  "access-control-allow-origin": process.env.CORS_ALLOWED_ORIGIN || "*",
  "access-control-allow-headers": "authorization,content-type,idempotency-key",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
};

const JSON_HEADERS = {
  "content-type": "application/json",
  ...CORS_HEADERS,
};

export function createHttpRouterHandler({ app, handlerName }) {
  return async (event, context) => {
    const correlationId = getCorrelationId(event);
    const method = event.httpMethod || event?.requestContext?.http?.method;
    const path = event.path || event?.requestContext?.http?.path;
    logger.appendKeys({ correlationId, handler: handlerName, method, path });
    logger.info("request received");

    // CORS preflight short-circuit — API Gateway sometimes routes
    // OPTIONS through the integration when the SAM Auth.DefaultAuthorizer
    // is set. Return immediately with the allow headers.
    if (method === "OPTIONS") {
      return {
        statusCode: 204,
        headers: CORS_HEADERS,
        body: "",
      };
    }

    // The Router catches its own routing/handler errors and invokes the
    // errorHandler registered on the app — that's where ApiError → status
    // mapping happens. This outer try/catch only catches things that
    // escape the Router itself (e.g., InvalidEventError on a malformed
    // event).
    try {
      const response = await app.resolve(event, context);
      return finalize(response);
    } catch (err) {
      if (err instanceof ApiError) {
        logger.warn(`${handlerName} mapped error`, {
          statusCode: err.statusCode,
          code: err.code,
          message: err.message,
        });
        return jsonResponse(err.statusCode, { message: err.message, code: err.code });
      }
      logger.error(`${handlerName} unhandled error`, {
        errorName: err?.name,
        error: err?.message,
        stack: err?.stack,
      });
      return jsonResponse(500, { message: "Internal server error" });
    } finally {
      // Clear request-scoped logger keys so the next invocation starts fresh.
      logger.resetKeys();
    }
  };
}

export function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: typeof body === "string" ? JSON.stringify({ message: body }) : JSON.stringify(body),
  };
}

// HTTP statuses that the Fetch `Response` spec forbids from carrying a
// body. The Powertools Router builds a `new Response(body, { status })`
// from our return value, and undici throws "invalid response status
// code" if a non-null body (even "") is paired with one of these. So we
// must omit the body entirely for them.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// Shared JSON body parser for every route module. `optional: true` allows
// an absent body (e.g. a POST that takes no payload) and returns {} so
// validators can treat "no body" and "empty object" the same way.
export function parseBody(event, { optional = false } = {}) {
  if (!event.body) {
    if (optional) return {};
    throw new BadRequestError("Missing request body");
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}

export function emptyResponse(statusCode = 204) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: NULL_BODY_STATUSES.has(statusCode) ? null : "",
  };
}

// Normalizes the Powertools Router return value into the API Gateway
// response shape. The Router can return either a `Response` instance
// (Fetch API style) or a plain object — handle both.
async function finalize(response) {
  if (response && typeof response === "object" && "statusCode" in response) {
    // Already-shaped API Gateway response. Just ensure CORS headers exist.
    return {
      ...response,
      headers: { ...CORS_HEADERS, ...(response.headers ?? {}) },
    };
  }

  if (typeof Response !== "undefined" && response instanceof Response) {
    const body = await response.text();
    const headers = {};
    for (const [k, v] of response.headers.entries()) headers[k] = v;
    return {
      statusCode: response.status,
      headers: { ...CORS_HEADERS, ...headers },
      body,
    };
  }

  // Bare object — assume 200 JSON.
  return jsonResponse(200, response);
}

function getCorrelationId(event) {
  const headers = event?.headers ?? {};
  return (
    headers["x-correlation-id"] ||
    headers["X-Correlation-Id"] ||
    event?.requestContext?.requestId ||
    null
  );
}
