import {
  conversationToTranscript,
  validateBriefSubmission,
  validateUploadUrlRequest,
} from "../validation/brief.mjs";
import { BadRequestError } from "../services/errors.mjs";

describe("validateUploadUrlRequest", () => {
  test("accepts empty body", () => {
    expect(validateUploadUrlRequest({})).toEqual({ content_type: "application/pdf" });
    expect(validateUploadUrlRequest(undefined)).toEqual({});
  });

  test("rejects non-pdf content_type", () => {
    expect(() => validateUploadUrlRequest({ content_type: "image/png" })).toThrow(BadRequestError);
  });

  test("accepts explicit application/pdf", () => {
    expect(validateUploadUrlRequest({ content_type: "application/pdf" })).toEqual({
      content_type: "application/pdf",
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
    test("requires ULID brief_id", () => {
      expect(() =>
        validateBriefSubmission({ source_type: "pdf", brief_id: "abc" }),
      ).toThrow(/ULID/);
    });

    test("happy path", () => {
      expect(
        validateBriefSubmission({
          source_type: "pdf",
          brief_id: "01HV0AABBCCDDEEFFGGHHJJKKM",
        }),
      ).toEqual({ source_type: "pdf", brief_id: "01HV0AABBCCDDEEFFGGHHJJKKM" });
    });
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
