import { jest } from "@jest/globals";

const { fetchContentText, htmlToText, isPublicHttpUrl, rscPlaintextUrl } =
  await import("../services/content-fetch.mjs");

function htmlResponse(body, { ok = true, status = 200, contentType = "text/html; charset=utf-8" } = {}) {
  return {
    ok,
    status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  };
}

function textResponse(body, opts = {}) {
  return htmlResponse(body, { contentType: "text/plain; charset=utf-8", ...opts });
}

describe("services/content-fetch htmlToText", () => {
  test("strips scripts, styles, and tags and decodes entities", () => {
    const html = `
      <html><head><title>t</title><style>.a{color:red}</style></head>
      <body>
        <script>tracker()</script>
        <p>Hello &amp; welcome to my &quot;blog&quot;.</p>
        <p>It&#39;s about &lt;widgets&gt;.</p>
      </body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Hello & welcome to my "blog".');
    // <widgets> here is decoded from &lt;widgets&gt;, not a leftover tag.
    expect(text).toContain("It's about <widgets>.");
    expect(text).not.toContain("tracker()");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("<style>");
  });

  test("prefers the <article> region over surrounding nav/footer", () => {
    const html = `
      <body>
        <nav>Home About Contact</nav>
        <article><h1>Real Title</h1><p>The actual post body.</p></article>
        <footer>Copyright 2026 unrelated junk</footer>
      </body>`;
    const text = htmlToText(html);
    expect(text).toContain("Real Title");
    expect(text).toContain("The actual post body.");
    expect(text).not.toContain("Copyright 2026");
    expect(text).not.toContain("Home About Contact");
  });

  test("collapses runaway whitespace", () => {
    // Five blank lines between a and b collapse to one blank line; the single
    // boundary between b and c collapses to a single newline.
    const text = htmlToText("<p>a</p>\n\n\n\n<p>b</p>          <p>c</p>");
    expect(text).toBe("a\n\nb\nc");
  });

  test("returns empty string for empty/non-string input", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText(null)).toBe("");
  });
});

describe("services/content-fetch isPublicHttpUrl", () => {
  test("accepts normal public http(s) URLs", () => {
    expect(isPublicHttpUrl("https://medium.com/@me/post")).toBe(true);
    expect(isPublicHttpUrl("http://dev.to/me/post")).toBe(true);
    expect(isPublicHttpUrl("https://example.com")).toBe(true);
  });

  test("rejects non-http(s) schemes and junk", () => {
    expect(isPublicHttpUrl("ftp://example.com")).toBe(false);
    expect(isPublicHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isPublicHttpUrl("not a url")).toBe(false);
  });

  test("rejects internal hostnames", () => {
    expect(isPublicHttpUrl("http://localhost/x")).toBe(false);
    expect(isPublicHttpUrl("http://api.local/x")).toBe(false);
    expect(isPublicHttpUrl("http://metadata.google.internal/x")).toBe(false);
  });

  test("rejects private, loopback, and link-local IP literals", () => {
    expect(isPublicHttpUrl("http://127.0.0.1/x")).toBe(false);
    expect(isPublicHttpUrl("http://10.1.2.3/x")).toBe(false);
    expect(isPublicHttpUrl("http://172.16.0.5/x")).toBe(false);
    expect(isPublicHttpUrl("http://192.168.1.1/x")).toBe(false);
    expect(isPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isPublicHttpUrl("http://[::1]/x")).toBe(false);
    expect(isPublicHttpUrl("http://[fe80::1]/x")).toBe(false);
  });

  test("allows public IP literals", () => {
    expect(isPublicHttpUrl("http://8.8.8.8/x")).toBe(true);
    expect(isPublicHttpUrl("http://172.32.0.1/x")).toBe(true);
  });
});

describe("services/content-fetch rscPlaintextUrl", () => {
  test("maps an RSC page to its /index.txt sibling", () => {
    expect(rscPlaintextUrl("https://www.readysetcloud.io/blog/my-post")).toBe(
      "https://www.readysetcloud.io/blog/my-post/index.txt",
    );
    expect(rscPlaintextUrl("https://readysetcloud.io/blog/my-post/")).toBe(
      "https://readysetcloud.io/blog/my-post/index.txt",
    );
  });

  test("drops query and fragment before appending", () => {
    expect(rscPlaintextUrl("https://www.readysetcloud.io/blog/my-post?utm=x#h")).toBe(
      "https://www.readysetcloud.io/blog/my-post/index.txt",
    );
  });

  test("returns null for non-RSC hosts", () => {
    expect(rscPlaintextUrl("https://medium.com/@me/post")).toBeNull();
    expect(rscPlaintextUrl("https://dev.to/me/post")).toBeNull();
  });

  test("leaves an already-plaintext URL alone", () => {
    expect(rscPlaintextUrl("https://www.readysetcloud.io/blog/my-post/index.txt")).toBeNull();
  });
});

describe("services/content-fetch fetchContentText", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns extracted text on a successful HTML fetch", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      htmlResponse("<article><p>My great post.</p></article>"),
    );
    const text = await fetchContentText("https://example.com/post");
    expect(text).toBe("My great post.");

    // Sends a normal-looking UA and a timeout signal.
    const opts = global.fetch.mock.calls[0][1];
    expect(opts.headers["user-agent"]).toMatch(/Mozilla/);
    expect(opts.signal).toBeDefined();
  });

  test("uses RSC prebuilt plaintext as-is (no HTML stripping)", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      textResponse("# My Post\n\nFirst para.\n\nSecond   para keeps   spacing."),
    );

    const text = await fetchContentText("https://www.readysetcloud.io/blog/my-post");

    // Fetched the /index.txt sibling, not the original page.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe(
      "https://www.readysetcloud.io/blog/my-post/index.txt",
    );
    // Returned verbatim (trimmed) — internal spacing is not collapsed the way
    // htmlToText would.
    expect(text).toBe("# My Post\n\nFirst para.\n\nSecond   para keeps   spacing.");
  });

  test("falls back to HTML scrape when the RSC plaintext is missing", async () => {
    global.fetch = jest.fn().mockImplementation((u) => {
      if (u.endsWith("/index.txt")) return Promise.resolve(textResponse("nope", { ok: false, status: 404 }));
      return Promise.resolve(htmlResponse("<article><p>Scraped body.</p></article>"));
    });

    const text = await fetchContentText("https://www.readysetcloud.io/blog/my-post");

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0]).toBe(
      "https://www.readysetcloud.io/blog/my-post/index.txt",
    );
    expect(global.fetch.mock.calls[1][0]).toBe("https://www.readysetcloud.io/blog/my-post");
    expect(text).toBe("Scraped body.");
  });

  test("returns null (non-fatal) when the request throws", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ENOTFOUND"));
    expect(await fetchContentText("https://nope.example")).toBeNull();
  });

  test("never makes the request for a non-public URL (SSRF guard)", async () => {
    global.fetch = jest.fn();
    expect(await fetchContentText("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("returns null on a non-OK status", async () => {
    global.fetch = jest.fn().mockResolvedValue(htmlResponse("forbidden", { ok: false, status: 403 }));
    expect(await fetchContentText("https://example.com/x")).toBeNull();
  });

  test("returns null when the response isn't text/html", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      htmlResponse("%PDF-1.7", { contentType: "application/pdf" }),
    );
    expect(await fetchContentText("https://example.com/x.pdf")).toBeNull();
  });

  test("returns null when extraction yields nothing", async () => {
    global.fetch = jest.fn().mockResolvedValue(htmlResponse("<html><body></body></html>"));
    expect(await fetchContentText("https://example.com/blank")).toBeNull();
  });

  test("caps very long content", async () => {
    const huge = `<article>${"word ".repeat(60_000)}</article>`;
    global.fetch = jest.fn().mockResolvedValue(htmlResponse(huge));
    const text = await fetchContentText("https://example.com/long");
    expect(text.length).toBe(50_000);
  });
});
