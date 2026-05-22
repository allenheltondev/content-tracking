import { jest } from "@jest/globals";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const { DynamoDBClient, GetItemCommand, DeleteItemCommand } = await import("@aws-sdk/client-dynamodb");

process.env.TABLE_NAME = "test-content-tracking";
process.env.NEWSLETTER_API_BASE_URL = "https://example.execute-api.us-east-1.amazonaws.com/public";
process.env.NEWSLETTER_MINT_API_KEY = "test-mint-api-key-value";

const { handler } = await import("../delete-campaign-link.mjs");

const existingLink = marshall({
  pk: "CAMPAIGN#camp_abc",
  sk: "LINK#01HV0LINK0000000000000000A",
  entity: "Link",
  campaignId: "camp_abc",
  linkId: "01HV0LINK0000000000000000A",
  code: "aB3xKp",
  shortUrl: "https://rdyset.click/c/aB3xKp",
  role: "main",
  platform: "readysetcloud",
  url: "https://readysetcloud.io/some-post",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const invoke = ({ campaignId = "camp_abc", linkId = "01HV0LINK0000000000000000A" } = {}) => handler({
  pathParameters: { campaignId, linkId },
});

describe("delete-campaign-link", () => {
  let mockDdbSend;
  let fetchSpy;

  beforeEach(() => {
    mockDdbSend = jest.fn();
    DynamoDBClient.prototype.send = mockDdbSend;

    fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      status: 204,
      text: async () => "",
    }));

    jest.clearAllMocks();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("returns 400 when campaignId is missing", async () => {
    const res = await handler({ pathParameters: { linkId: "01HV0LINK0000000000000000A" } });
    expect(res.statusCode).toBe(400);
    expect(mockDdbSend).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns 400 when linkId is missing", async () => {
    const res = await handler({ pathParameters: { campaignId: "camp_abc" } });
    expect(res.statusCode).toBe(400);
  });

  test("returns 404 when the link does not exist locally (no upstream call)", async () => {
    mockDdbSend.mockImplementation((cmd) => {
      if (cmd instanceof GetItemCommand) return Promise.resolve({});
      return Promise.resolve({});
    });

    const res = await invoke();
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).message).toMatch(/Link 01HV0LINK0000000000000000A/);
    expect(fetchSpy).not.toHaveBeenCalled();

    // GetItem only; should not have tried to delete locally either
    const deletes = mockDdbSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof DeleteItemCommand);
    expect(deletes).toHaveLength(0);
  });

  describe("with an existing link", () => {
    beforeEach(() => {
      mockDdbSend.mockImplementation((cmd) => {
        if (cmd instanceof GetItemCommand) return Promise.resolve({ Item: existingLink });
        if (cmd instanceof DeleteItemCommand) return Promise.resolve({});
        return Promise.resolve({});
      });
    });

    test("calls newsletter-service DELETE /links/{code} and returns 204 on success", async () => {
      const res = await invoke();
      expect(res.statusCode).toBe(204);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${process.env.NEWSLETTER_API_BASE_URL}/links/aB3xKp`);
      expect(opts.method).toBe("DELETE");
      expect(opts.headers["Authorization"]).toBe("test-mint-api-key-value");

      const deletes = mockDdbSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof DeleteItemCommand);
      expect(deletes).toHaveLength(1);
      const key = unmarshall(deletes[0].input.Key);
      expect(key.pk).toBe("CAMPAIGN#camp_abc");
      expect(key.sk).toBe("LINK#01HV0LINK0000000000000000A");
    });

    test("proceeds with local delete when newsletter-service returns 404", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => '{"message":"not found"}',
      });

      const res = await invoke();
      expect(res.statusCode).toBe(204);

      const deletes = mockDdbSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof DeleteItemCommand);
      expect(deletes).toHaveLength(1);
    });

    test("returns 502 when newsletter-service returns 5xx (does NOT delete local)", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => '{"message":"boom"}',
      });

      const res = await invoke();
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).message).toMatch(/Upstream/);

      const deletes = mockDdbSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof DeleteItemCommand);
      expect(deletes).toHaveLength(0);
    });

    test("returns 502 when newsletter-service returns a non-404 4xx", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '{"message":"forbidden"}',
      });

      const res = await invoke();
      expect(res.statusCode).toBe(502);

      const deletes = mockDdbSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof DeleteItemCommand);
      expect(deletes).toHaveLength(0);
    });

    test("returns 502 when fetch throws (network failure)", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("ENOTFOUND"));
      const res = await invoke();
      expect(res.statusCode).toBe(502);

      const deletes = mockDdbSend.mock.calls
        .map((c) => c[0])
        .filter((c) => c instanceof DeleteItemCommand);
      expect(deletes).toHaveLength(0);
    });
  });
});
