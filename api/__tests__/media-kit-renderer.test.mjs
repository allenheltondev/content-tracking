import { describe, expect, test } from "@jest/globals";
import { renderMediaKitHtml } from "../services/media-kit-renderer.mjs";

describe("renderMediaKitHtml", () => {
  test("injects the snapshot JSON into the template", () => {
    const snapshot = { report: { id: "K1" }, identity: { displayName: "Allen" }, stats: {} };
    const html = renderMediaKitHtml(snapshot);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('"id":"K1"');
    expect(html).not.toContain("__MEDIA_KIT_DATA__");
  });

  test("escapes </script> sequences so the payload can't break out", () => {
    const snapshot = { identity: { bio: "</script><script>alert(1)</script>" } };
    const html = renderMediaKitHtml(snapshot);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script");
  });

  test("handles snapshots containing `$` without mangling", () => {
    const snapshot = { rateCard: [{ deliverable: "Post", price: 5 }], note: "$5 & up" };
    const html = renderMediaKitHtml(snapshot);
    expect(html).toContain("$5");
  });

  test("defaults to noindex; the indexable flag flips it to index/follow", () => {
    const snapshot = { report: { id: "K1" }, identity: {}, stats: {} };

    const priv = renderMediaKitHtml(snapshot);
    expect(priv).toContain('content="noindex, nofollow"');
    expect(priv).not.toContain('content="index, follow"');

    const pub = renderMediaKitHtml(snapshot, { indexable: true });
    expect(pub).toContain('content="index, follow"');
    expect(pub).not.toContain('content="noindex, nofollow"');
  });
});
