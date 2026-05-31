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

  test("private kit ships with no SEO head block", () => {
    const snapshot = { identity: { displayName: "Allen", bio: "Hi" }, stats: {} };
    const html = renderMediaKitHtml(snapshot);
    // The head token is stripped, and no OG/JSON-LD leaks into private kits.
    expect(html).not.toContain("__MEDIA_KIT_HEAD__");
    expect(html).not.toContain('property="og:title"');
    expect(html).not.toContain("application/ld+json");
  });

  const SEO_SNAPSHOT = {
    report: { id: "K1" },
    brand: { name: "RSC", websiteUrl: "https://readysetcloud.io" },
    identity: {
      displayName: "Allen Helton",
      tagline: "Serverless educator",
      bio: "I teach cloud & serverless to developers.",
      location: "Tennessee, USA",
      contactEmail: "a@b.co",
      niches: ["AWS", "Serverless"],
      avatarUrl: "https://kit.example.com/allen/avatar",
    },
    socialAccounts: [
      { platform: "x", handle: "@allenheltondev", url: "https://x.com/allenheltondev" },
      { platform: "youtube", handle: null, url: "https://youtube.com/@allen" },
    ],
    stats: {},
  };

  test("public kit server-renders title, description, OG, Twitter, canonical, JSON-LD", () => {
    const html = renderMediaKitHtml(SEO_SNAPSHOT, {
      indexable: true,
      pageUrl: "https://kit.example.com/allen",
    });

    expect(html).toContain("<title>Allen Helton — Serverless educator</title>");
    // The generic default title is removed so crawlers can't read it first;
    // the SEO title is the only <title> in the document.
    expect(html).not.toContain("<title>Media Kit</title>");
    expect(html.match(/<title>/g) ?? []).toHaveLength(1);
    expect(html).toContain('<meta name="description" content="I teach cloud &amp; serverless to developers.">');
    expect(html).toContain('<link rel="canonical" href="https://kit.example.com/allen">');

    // Open Graph
    expect(html).toContain('<meta property="og:type" content="profile">');
    expect(html).toContain('<meta property="og:url" content="https://kit.example.com/allen">');
    expect(html).toContain('<meta property="og:image" content="https://kit.example.com/allen/avatar">');

    // Twitter card with image + creator handle
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta name="twitter:creator" content="@allenheltondev">');

    // JSON-LD ProfilePage/Person with sameAs links
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type":"ProfilePage"');
    expect(html).toContain('"@type":"Person"');
    expect(html).toContain('"https://x.com/allenheltondev"');
    expect(html).toContain('"https://youtube.com/@allen"');
  });

  test("twitter card downgrades to summary without an image", () => {
    const noImage = { ...SEO_SNAPSHOT, identity: { ...SEO_SNAPSHOT.identity, avatarUrl: null } };
    const html = renderMediaKitHtml(noImage, { indexable: true, pageUrl: "https://kit.example.com/allen" });
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).not.toContain('property="og:image"');
  });

  test("falls back to tagline then a generated description when bio is absent", () => {
    const noBio = { ...SEO_SNAPSHOT, identity: { ...SEO_SNAPSHOT.identity, bio: null } };
    const html = renderMediaKitHtml(noBio, { indexable: true, pageUrl: "https://kit.example.com/allen" });
    expect(html).toContain('<meta name="description" content="Serverless educator">');
  });

  test("JSON-LD payload can't break out of its script tag", () => {
    const evil = {
      ...SEO_SNAPSHOT,
      identity: { ...SEO_SNAPSHOT.identity, tagline: "</script><script>alert(1)</script>" },
    };
    const html = renderMediaKitHtml(evil, { indexable: true, pageUrl: "https://kit.example.com/allen" });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script");
  });
});
