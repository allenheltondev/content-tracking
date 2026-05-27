import { jest } from "@jest/globals";

const { extractGoogleDocId, fetchGoogleDocText } = await import("../services/google-docs.mjs");
const { BadRequestError, UpstreamError } = await import("../services/errors.mjs");

describe("extractGoogleDocId", () => {
  test("pulls the id from a shared edit URL", () => {
    expect(
      extractGoogleDocId("https://docs.google.com/document/d/ABC123_-x/edit?usp=sharing"),
    ).toBe("ABC123_-x");
  });

  test("pulls the id from a bare doc URL", () => {
    expect(extractGoogleDocId("https://docs.google.com/document/d/XYZ")).toBe("XYZ");
  });

  test("returns null for a non-Google URL", () => {
    expect(extractGoogleDocId("https://example.com/draft")).toBeNull();
  });

  test("returns null for a non-string", () => {
    expect(extractGoogleDocId(null)).toBeNull();
  });
});

describe("fetchGoogleDocText", () => {
  afterEach(() => {
    delete global.fetch;
  });

  const mockFetch = (response) => {
    global.fetch = jest.fn(async () => response);
  };

  const textResponse = (body, contentType = "text/plain; charset=utf-8") => ({
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    text: async () => body,
  });

  test("returns the exported text for a link-shared doc", async () => {
    mockFetch(textResponse("My draft body"));
    expect(await fetchGoogleDocText("docid")).toBe("My draft body");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://docs.google.com/document/d/docid/export?format=txt",
      expect.objectContaining({ redirect: "follow" }),
    );
  });

  test("400 when a private doc resolves to the HTML sign-in page", async () => {
    mockFetch(textResponse("<html>sign in</html>", "text/html; charset=utf-8"));
    await expect(fetchGoogleDocText("docid")).rejects.toThrow(BadRequestError);
  });

  test("400 on a 403 from Google", async () => {
    mockFetch({ ok: false, status: 403, headers: { get: () => "" }, text: async () => "" });
    await expect(fetchGoogleDocText("docid")).rejects.toThrow(BadRequestError);
  });

  test("502 on a 500 from Google", async () => {
    mockFetch({ ok: false, status: 500, headers: { get: () => "" }, text: async () => "" });
    await expect(fetchGoogleDocText("docid")).rejects.toThrow(UpstreamError);
  });

  test("502 on a network error", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(fetchGoogleDocText("docid")).rejects.toThrow(UpstreamError);
  });

  test("400 on an empty doc", async () => {
    mockFetch(textResponse("   \n  "));
    await expect(fetchGoogleDocText("docid")).rejects.toThrow(/empty/);
  });
});
