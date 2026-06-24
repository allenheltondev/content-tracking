import { chunkMarkdown } from "../services/chunking.mjs";

describe("services/chunking chunkMarkdown", () => {
  test("returns empty for empty/blank input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\n  ")).toEqual([]);
    expect(chunkMarkdown(null)).toEqual([]);
  });

  test("short text becomes a single chunk indexed from 0", () => {
    const chunks = chunkMarkdown("# Title\n\nA short post.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].text).toContain("A short post.");
  });

  test("packs multiple paragraphs under the target into one chunk", () => {
    const text = ["para one", "para two", "para three"].join("\n\n");
    const chunks = chunkMarkdown(text, { targetChars: 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("para one");
    expect(chunks[0].text).toContain("para three");
  });

  test("splits into multiple chunks once the target is exceeded", () => {
    const para = "x".repeat(400);
    const text = Array.from({ length: 6 }, () => para).join("\n\n");
    const chunks = chunkMarkdown(text, { targetChars: 1000, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  test("applies overlap from the previous chunk to all but the first", () => {
    const a = "AAAA".repeat(300); // 1200 chars
    const b = "BBBB".repeat(300);
    const chunks = chunkMarkdown(`${a}\n\n${b}`, { targetChars: 1300, overlapChars: 100 });
    expect(chunks.length).toBe(2);
    // The second chunk should carry a tail of the first chunk's text.
    expect(chunks[1].text.startsWith("A")).toBe(true);
    expect(chunks[1].text).toContain("BBBB");
  });

  test("hard-splits a single oversized block so no chunk exceeds maxChars", () => {
    const huge = "z".repeat(20_000);
    const chunks = chunkMarkdown(huge, { targetChars: 2000, maxChars: 6000, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(6000);
    }
  });

  test("caps the number of chunks at maxChunks", () => {
    const text = Array.from({ length: 50 }, (_, i) => `para ${i} ${"y".repeat(100)}`).join("\n\n");
    const chunks = chunkMarkdown(text, { targetChars: 120, overlapChars: 0, maxChunks: 5 });
    expect(chunks.length).toBe(5);
  });
});
