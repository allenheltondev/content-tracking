import { logger } from "./logger.mjs";
import { BadRequestError, UpstreamError } from "./errors.mjs";

// Pulls plain text out of a Google Doc so the draft-review pipeline can
// feed it to Bedrock. We use the public export endpoint
//   https://docs.google.com/document/d/{id}/export?format=txt
// which requires no OAuth — but only works when the doc is shared so
// "anyone with the link can view". A private doc instead 302s to the
// Google sign-in page (an HTML body with a 200), which we detect and
// turn into a clear 400 telling the user to fix the sharing setting.

// Bedrock's context plus our maxTokens cap a draft well under this, but a
// runaway export (e.g. a 200-page doc) would just waste tokens and time.
const MAX_DRAFT_CHARS = 200_000;

// Matches the doc id in the canonical share/edit URL shapes:
//   https://docs.google.com/document/d/{ID}/edit
//   https://docs.google.com/document/d/{ID}/edit?usp=sharing
//   https://docs.google.com/document/d/{ID}
export function extractGoogleDocId(url) {
  if (typeof url !== "string") return null;
  const match = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

export async function fetchGoogleDocText(docId) {
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;

  let response;
  try {
    response = await fetch(exportUrl, { redirect: "follow" });
  } catch (err) {
    logger.error("Google Docs export fetch failed", { docId, error: err?.message });
    throw new UpstreamError(`Failed to fetch Google Doc: ${err?.message ?? "unknown"}`, 502);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new BadRequestError(
        "Could not access the Google Doc. Share it so anyone with the link can view, then try again.",
      );
    }
    logger.error("Google Docs export non-OK", { docId, status: response.status });
    throw new UpstreamError(`Google Docs returned ${response.status}`, 502);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  // A doc that isn't link-shared resolves to the sign-in page: HTTP 200
  // with an HTML body rather than the text/plain export we asked for.
  if (contentType.includes("text/html")) {
    throw new BadRequestError(
      "The Google Doc isn't publicly viewable. Share it so anyone with the link can view, then try again.",
    );
  }

  if (text.trim().length === 0) {
    throw new BadRequestError("The Google Doc appears to be empty.");
  }

  if (text.length > MAX_DRAFT_CHARS) {
    throw new BadRequestError(
      `The draft is too long to review (${text.length} characters; limit ${MAX_DRAFT_CHARS}).`,
    );
  }

  return text;
}
