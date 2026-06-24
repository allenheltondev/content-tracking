// Markdown-aware chunking for blog vectorization. Splits a post's text into
// overlapping chunks small enough to embed individually and to fit inside an
// S3 Vectors metadata record (40 KB/vector total, so a chunk's stored text
// must stay well under that). Chunking by paragraph/heading boundaries keeps
// each chunk semantically coherent, which gives better retrieval than a blind
// fixed-width split; a small character overlap stops a sentence that straddles
// a boundary from being lost to both neighbours.
//
// Pure and synchronous so it's cheap to unit-test. The vectorizer assembles
// the input (title + description + body) and feeds it here.

const DEFAULTS = {
  // ~2 KB lands a chunk around 400-500 tokens — a good retrieval granularity
  // for Titan v2 and comfortably under the metadata cap once the embedding
  // and keys are added.
  targetChars: 2000,
  // Trailing slice of one chunk repeated at the head of the next so a thought
  // split across the boundary survives in at least one whole chunk.
  overlapChars: 200,
  // A single block (e.g. a giant code fence or table) longer than this is
  // hard-split by characters so no chunk ever exceeds the embed/metadata bound.
  maxChars: 6000,
  // Backstop so a pathological post (tons of tiny lines) can't explode into
  // thousands of vectors. Excess is dropped; the caller logs when it happens.
  maxChunks: 512,
};

// Splits markdown into chunks. Returns [{ index, text }]. `index` is the
// chunk's position (0-based) and doubles as the suffix of its vector key, so
// it must stay stable for a given input.
export function chunkMarkdown(rawText, opts = {}) {
  const { targetChars, overlapChars, maxChars, maxChunks } = { ...DEFAULTS, ...opts };

  const text = normalize(rawText);
  if (text.length === 0) return [];

  const blocks = splitIntoBlocks(text, maxChars);

  // Greedily pack blocks into chunks up to targetChars. A block that on its
  // own exceeds targetChars (but is <= maxChars after the hard-split above)
  // becomes its own chunk rather than forcing a tiny trailing chunk.
  const rawChunks = [];
  let current = "";
  for (const block of blocks) {
    if (current.length === 0) {
      current = block;
    } else if (current.length + 2 + block.length <= targetChars) {
      current = `${current}\n\n${block}`;
    } else {
      rawChunks.push(current);
      current = block;
    }
  }
  if (current.length > 0) rawChunks.push(current);

  // Add a leading overlap from the previous chunk's tail. The first chunk has
  // nothing before it, so it's left untouched.
  const withOverlap = rawChunks.map((chunk, i) => {
    if (i === 0 || overlapChars <= 0) return chunk;
    const prev = rawChunks[i - 1];
    const tail = prev.slice(Math.max(0, prev.length - overlapChars));
    return `${tail.trimStart()}\n\n${chunk}`;
  });

  return withOverlap
    .slice(0, maxChunks)
    .map((text, index) => ({ index, text }));
}

// Collapses Windows/Mac newlines and trims trailing whitespace so block
// boundaries (blank lines) are detected consistently.
function normalize(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

// Splits text into paragraph/heading blocks on blank lines, then hard-splits
// any single block longer than maxChars so no block can blow the chunk bound.
function splitIntoBlocks(text, maxChars) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const blocks = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      blocks.push(p);
      continue;
    }
    for (let i = 0; i < p.length; i += maxChars) {
      blocks.push(p.slice(i, i + maxChars));
    }
  }
  return blocks;
}
