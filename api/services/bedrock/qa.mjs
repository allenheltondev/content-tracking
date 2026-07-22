import { z } from "zod";
import { invokeStructured, streamConverseText } from "./client.mjs";

// Grounded Q&A over the creator's own catalog: structured (schema-forced)
// answers for the REST endpoints, plus a streaming variant for the live
// "ask" experience.

// Schema the model's answer is forced to conform to when answering a question
// about the creator's blog catalog, grounded only in the provided excerpts.
// Structured output keeps the grounded answer, the sources it actually used,
// and a self-assessed confidence cleanly separated.
const BLOG_ANSWER_SCHEMA = z.object({
  answer: z
    .string()
    .describe(
      "The answer, written for the creator, grounded ONLY in the provided source excerpts. If the excerpts don't contain the answer, say so plainly rather than guessing.",
    ),
  sources_used: z
    .array(z.number().int().min(1))
    .describe(
      "The [n] source numbers whose excerpts the answer actually draws on. Empty when no source was relevant.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "How well the excerpts support the answer: 'high' when they directly and fully answer it, 'low' when they barely touch it or don't.",
    ),
});

const BLOG_QA_SYSTEM_PROMPT = `You are a research assistant for a content creator, answering questions about THEIR OWN past blog posts. You are given the question and a set of numbered excerpts retrieved from their catalog by semantic search.

Answer by calling the record_blog_answer tool. Rules:
- Ground the answer ONLY in the provided excerpts. Do not use outside knowledge or invent details the excerpts don't contain.
- Cite the excerpts you used by their [n] number in sources_used. Only list sources that genuinely informed the answer.
- The excerpts are ranked by relevance but some may be off-topic — ignore the ones that don't help.
- If the excerpts don't actually answer the question, say you couldn't find it in their catalog, set confidence to 'low', and leave sources_used empty.
- Write the answer in a direct, helpful voice ("You wrote about ...", "Your post on ... covers ..."). Do not write prose outside the tool — only call record_blog_answer.`;

// Answers a question grounded in retrieved content chunks. `chunks` is the
// ordered result of queryContentChunks ([{ contentId, title, text, ... }]); each
// becomes a numbered source the model may cite via sources_used (1-based,
// matching the order passed in). Returns { answer, sources_used, confidence }.
export async function answerBlogQuestion({ question, chunks }) {
  const sources = (chunks ?? [])
    .map((c, i) => {
      const title = c.title ? `"${c.title}"` : "(untitled)";
      return `[${i + 1}] ${title}\n${(c.text ?? "").trim()}`;
    })
    .join("\n\n");

  const input = `Question: ${question}\n\n=== SOURCE EXCERPTS (ranked by relevance) ===\n${sources}\n=== END EXCERPTS ===`;

  return invokeStructured({
    system: BLOG_QA_SYSTEM_PROMPT,
    input,
    schema: BLOG_ANSWER_SCHEMA,
    // Grounded synthesis: a little headroom for phrasing, but kept low so the
    // model stays close to the source text.
    temperature: 0.2,
    maxTokens: 1024,
  });
}

// Schema the model's answer is forced to conform to when answering a question
// about the creator's content catalog, grounded only in the provided excerpts.
// Same shape as the blog answer: the grounded answer, the sources it actually
// used, and a self-assessed confidence, kept separate.
const CONTENT_ANSWER_SCHEMA = z.object({
  answer: z
    .string()
    .describe(
      "The answer, written for the creator, grounded ONLY in the provided source excerpts. If the excerpts don't contain the answer, say so plainly rather than guessing.",
    ),
  sources_used: z
    .array(z.number().int().min(1))
    .describe(
      "The [n] source numbers whose excerpts the answer actually draws on. Empty when no source was relevant.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "How well the excerpts support the answer: 'high' when they directly and fully answer it, 'low' when they barely touch it or don't.",
    ),
});

const CONTENT_QA_SYSTEM_PROMPT = `You are a research assistant for a content creator, answering questions about THEIR OWN past content. You are given the question and a set of numbered excerpts retrieved from their catalog by semantic search.

Answer by calling the record_content_answer tool. Rules:
- Ground the answer ONLY in the provided excerpts. Do not use outside knowledge or invent details the excerpts don't contain.
- Cite the excerpts you used by their [n] number in sources_used. Only list sources that genuinely informed the answer.
- The excerpts are ranked by relevance but some may be off-topic — ignore the ones that don't help.
- If the excerpts don't actually answer the question, say you couldn't find it in their posts, set confidence to 'low', and leave sources_used empty.
- Write the answer in a direct, helpful voice ("You wrote about ...", "Your post on ... covers ..."). Do not write prose outside the tool — only call record_content_answer.`;

// Answers a question grounded in retrieved content chunks. `chunks` is the
// ordered result of queryContentChunks ([{ contentId, title, text, ... }]); each
// becomes a numbered source the model may cite via sources_used (1-based,
// matching the order passed in). Returns { answer, sources_used, confidence }.
export async function answerContentQuestion({ question, chunks }) {
  const sources = (chunks ?? [])
    .map((c, i) => {
      const title = c.title ? `"${c.title}"` : "(untitled)";
      return `[${i + 1}] ${title}\n${(c.text ?? "").trim()}`;
    })
    .join("\n\n");

  const input = `Question: ${question}\n\n=== SOURCE EXCERPTS (ranked by relevance) ===\n${sources}\n=== END EXCERPTS ===`;

  return invokeStructured({
    system: CONTENT_QA_SYSTEM_PROMPT,
    input,
    schema: CONTENT_ANSWER_SCHEMA,
    // Grounded synthesis: a little headroom for phrasing, but kept low so the
    // model stays close to the source text.
    temperature: 0.2,
    maxTokens: 1024,
  });
}

const ASK_STREAM_SYSTEM = `You are a research assistant answering questions about a content creator's OWN past blog posts, using ONLY the provided excerpts. If the excerpts don't contain the answer, say you couldn't find it in their catalog rather than guessing. Write in a direct, helpful voice ("You wrote about ..."). Output ONLY the answer prose — no preamble.`;

// Streams a grounded answer over retrieved blog chunks. Mirrors
// answerBlogQuestion's inputs; yields text deltas. Citations are derived by the
// caller from the retrieved chunks (the stream carries only prose).
export function streamBlogAnswer({ question, chunks }) {
  const sources = (chunks ?? [])
    .map((c, i) => `[${i + 1}] ${c.title ? `"${c.title}"` : "(untitled)"}\n${(c.text ?? "").trim()}`)
    .join("\n\n");

  const userText = `Question: ${question}\n\n=== SOURCE EXCERPTS (ranked by relevance) ===\n${sources}\n=== END EXCERPTS ===`;

  return streamConverseText({
    system: ASK_STREAM_SYSTEM,
    userText,
    temperature: 0.2,
    maxTokens: 1024,
  });
}
