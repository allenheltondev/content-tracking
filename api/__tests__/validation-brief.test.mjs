import {
  conversationToTranscript,
  validateBriefImport,
  validateBriefSubmission,
  validateUploadUrlRequest,
} from "../validation/brief.mjs";
import { BadRequestError } from "../services/errors.mjs";

describe("validateUploadUrlRequest", () => {
  test("accepts empty body", () => {
    const pdf = { content_type: "application/pdf", format: "pdf" };
    expect(validateUploadUrlRequest({})).toEqual(pdf);
    expect(validateUploadUrlRequest(undefined)).toEqual(pdf);
  });

  test("rejects non-pdf content_type", () => {
    expect(() => validateUploadUrlRequest({ content_type: "image/png" })).toThrow(BadRequestError);
  });

  test("accepts explicit application/pdf", () => {
    expect(validateUploadUrlRequest({ content_type: "application/pdf" })).toEqual({
      content_type: "application/pdf",
      format: "pdf",
    });
  });

  test("accepts a Word document", () => {
    const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(validateUploadUrlRequest({ content_type: contentType })).toEqual({
      content_type: contentType,
      format: "docx",
    });
  });
});

describe("validateBriefSubmission", () => {
  test("rejects unknown source_type", () => {
    expect(() => validateBriefSubmission({ source_type: "audio" })).toThrow(BadRequestError);
    expect(() => validateBriefSubmission({})).toThrow(/source_type/);
  });

  describe("chat", () => {
    test("requires non-empty conversation", () => {
      expect(() =>
        validateBriefSubmission({ source_type: "chat", conversation: [] }),
      ).toThrow(/non-empty/);
    });

    test("rejects bad role", () => {
      expect(() =>
        validateBriefSubmission({
          source_type: "chat",
          conversation: [{ role: "robot", content: "hi" }],
        }),
      ).toThrow(/role/);
    });

    test("rejects empty content", () => {
      expect(() =>
        validateBriefSubmission({
          source_type: "chat",
          conversation: [{ role: "vendor", content: "" }],
        }),
      ).toThrow(/content/);
    });

    test("happy path normalizes shape", () => {
      const out = validateBriefSubmission({
        source_type: "chat",
        conversation: [
          { role: "vendor", content: "Looking for an IG reel" },
          { role: "influencer", content: "Sounds good, what's the budget?" },
        ],
      });
      expect(out.source_type).toBe("chat");
      expect(out.conversation.length).toBe(2);
    });
  });

  describe("pdf", () => {
    test("happy path needs no id (PDF is keyed by campaign)", () => {
      expect(validateBriefSubmission({ source_type: "pdf" })).toEqual({ source_type: "pdf" });
    });
  });
});

describe("validateBriefImport", () => {
  const uploadId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  test("accepts a staged file", () => {
    expect(validateBriefImport({ upload_id: uploadId, source_type: "docx", file_name: "Acme.docx" })).toEqual({
      uploadId,
      sourceType: "docx",
      fileName: "Acme.docx",
    });
  });

  test("rejects a bad upload id", () => {
    expect(() => validateBriefImport({ upload_id: "../other", source_type: "pdf" })).toThrow(BadRequestError);
  });

  test("rejects chat, which has no file", () => {
    expect(() => validateBriefImport({ upload_id: uploadId, source_type: "chat" })).toThrow(BadRequestError);
  });

  test("rejects an oversized file name", () => {
    expect(() =>
      validateBriefImport({ upload_id: uploadId, source_type: "pdf", file_name: "a".repeat(256) }),
    ).toThrow(BadRequestError);
  });
});

describe("conversationToTranscript", () => {
  test("joins entries on double newline with role prefix", () => {
    expect(
      conversationToTranscript([
        { role: "vendor", content: "Brief intro" },
        { role: "influencer", content: "Got it" },
      ]),
    ).toBe("vendor: Brief intro\n\ninfluencer: Got it");
  });
});
