import { BadRequestError } from "../services/errors.mjs";
import { extractGoogleDocId } from "../services/google-docs.mjs";

// A draft is the work-in-progress document for a campaign — almost always
// a Google Doc. We store any http(s) link, but only Google Docs links
// carry a docId, which is what the /draft/review endpoint needs to pull
// the text. Non-Google links can be stored but not (yet) auto-reviewed.
export function validateDraftSubmission(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("request body must be a JSON object");
  }

  const { url } = body;
  if (typeof url !== "string" || url.length === 0) {
    throw new BadRequestError("url must be a non-empty string");
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestError("url must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError("url must be an http(s) URL");
  }

  return { url, docId: extractGoogleDocId(url) };
}
