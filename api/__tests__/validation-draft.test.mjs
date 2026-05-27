import { validateDraftSubmission } from "../validation/draft.mjs";
import { BadRequestError } from "../services/errors.mjs";

describe("validateDraftSubmission", () => {
  test("extracts the docId from a Google Docs link", () => {
    const out = validateDraftSubmission({
      url: "https://docs.google.com/document/d/abc123/edit",
    });
    expect(out).toEqual({
      url: "https://docs.google.com/document/d/abc123/edit",
      docId: "abc123",
    });
  });

  test("stores a non-Google URL with a null docId", () => {
    const out = validateDraftSubmission({ url: "https://example.com/draft" });
    expect(out.docId).toBeNull();
    expect(out.url).toBe("https://example.com/draft");
  });

  test("rejects a missing url", () => {
    expect(() => validateDraftSubmission({})).toThrow(/url/);
  });

  test("rejects a non-object body", () => {
    expect(() => validateDraftSubmission(null)).toThrow(BadRequestError);
    expect(() => validateDraftSubmission([])).toThrow(BadRequestError);
  });

  test("rejects a non-http(s) protocol", () => {
    expect(() => validateDraftSubmission({ url: "ftp://host/file" })).toThrow(/http/);
  });

  test("rejects a malformed url", () => {
    expect(() => validateDraftSubmission({ url: "not a url" })).toThrow(/valid URL/);
  });
});
