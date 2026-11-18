import { fetchHashnodePostMetrics, HashnodeApiError } from "../src/hashnode.js";
import { HASHNODE_GQL_URL } from "../src/adapters.js";

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

describe("fetchHashnodePostMetrics", () => {
  test("queries the publication by host and slug and maps the counts", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        data: {
          publication: {
            id: "pub1",
            post: { id: "p1", slug: "my-post", views: 412, reactionCount: 9, responseCount: 3, replyCount: 1 },
          },
        },
      });
    };

    const metrics = await fetchHashnodePostMetrics("https://blog.example.com/my-post", { fetchImpl });

    expect(metrics).toEqual({ views: 412, reactions: 9, comments: 3, replies: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(HASHNODE_GQL_URL);
    expect(calls[0].init.method).toBe("POST");
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.variables).toEqual({ host: "blog.example.com", slug: "my-post" });
    expect(sent.query).toContain("publication(host: $host)");
    expect(sent.query).toContain("post(slug: $slug)");
  });

  test("falls back to the bare host when the subpath host is not a publication", async () => {
    const hosts = [];
    const fetchImpl = async (_url, init) => {
      const { host } = JSON.parse(init.body).variables;
      hosts.push(host);
      if (host === "example.com/blog") return jsonResponse({ data: { publication: null } });
      return jsonResponse({ data: { publication: { id: "x", post: { slug: "my-post", views: 2 } } } });
    };

    await expect(
      fetchHashnodePostMetrics("https://example.com/blog/my-post", { fetchImpl }),
    ).resolves.toEqual({ views: 2 });
    expect(hosts).toEqual(["example.com/blog", "example.com"]);
  });

  test("returns null when the publication has no such post", async () => {
    const fetchImpl = async () => jsonResponse({ data: { publication: { id: "x", post: null } } });
    await expect(
      fetchHashnodePostMetrics("https://allen.hashnode.dev/gone", { fetchImpl }),
    ).resolves.toBeNull();
  });

  test("throws a HashnodeApiError carrying the GraphQL error code", async () => {
    const fetchImpl = async () =>
      jsonResponse({
        data: null,
        errors: [
          {
            message: "This publication does not have an active Pro plan.",
            extensions: { code: "FORBIDDEN" },
          },
        ],
      });
    const err = await fetchHashnodePostMetrics("https://allen.hashnode.dev/my-post", { fetchImpl }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(HashnodeApiError);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toMatch(/Pro plan/);
  });

  test("throws on a non-JSON HTTP failure", async () => {
    const fetchImpl = async () => ({ ok: false, status: 502, text: async () => "Bad Gateway" });
    await expect(
      fetchHashnodePostMetrics("https://allen.hashnode.dev/my-post", { fetchImpl }),
    ).rejects.toThrow("HTTP 502");
  });

  test("makes no request for a URL without a slug", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return jsonResponse({});
    };
    await expect(fetchHashnodePostMetrics("https://allen.hashnode.dev/", { fetchImpl })).resolves.toBeNull();
    expect(called).toBe(false);
  });
});
