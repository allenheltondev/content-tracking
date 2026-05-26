// Typed errors that route handlers throw to signal API responses. The
// http-handler wrapper catches them and maps to status codes so route
// code stays declarative ("throw new NotFoundError('vendor', id)").

export class ApiError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code ?? this.constructor.name;
  }
}

export class BadRequestError extends ApiError {
  constructor(message) {
    super(400, message, "BadRequest");
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "Unauthorized") {
    super(401, message, "Unauthorized");
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden") {
    super(403, message, "Forbidden");
  }
}

export class NotFoundError extends ApiError {
  constructor(entity, id) {
    super(404, `${entity} ${id} not found`, "NotFound");
  }
}

export class ConflictError extends ApiError {
  constructor(message) {
    super(409, message, "Conflict");
  }
}

export class UpstreamError extends ApiError {
  constructor(message, upstreamStatus) {
    super(502, message, "UpstreamError");
    this.upstreamStatus = upstreamStatus;
  }
}
