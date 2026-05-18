export const respond = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? JSON.stringify({ message: body }) : JSON.stringify(body),
});

export const empty = (statusCode = 204) => ({
  statusCode,
});
