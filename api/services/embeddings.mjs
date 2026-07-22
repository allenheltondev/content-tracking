import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { logger } from "./logger.mjs";
import { UpstreamError } from "./errors.mjs";

// Text embeddings via Amazon Titan Text Embeddings V2 on Bedrock. Kept
// separate from services/bedrock/ (which owns the Converse chat pipeline)
// because embeddings use the InvokeModel API with a model-specific request
// body, a different model id, and a different env var — conflating them would
// muddy both. Billed through Bedrock (covered by AWS credits); the API
// Lambda's IAM already allows bedrock:InvokeModel on foundation models.

const MODEL_ID = process.env.EMBEDDING_MODEL_ID || "amazon.titan-embed-text-v2:0";
const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";

// Titan v2 supports 1024 / 512 / 256. 1024 is the default for best recall and
// must match the dimension the S3 vector index was created with.
export const EMBEDDING_DIMENSIONS = 1024;

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

// Embeds a single string and returns the embedding as number[]. `normalize`
// is on so cosine distance in the vector index behaves as expected. Throws
// UpstreamError on any Bedrock failure (matching services/bedrock/) so the
// vectorizer can let the record retry.
export async function embedText(text, { dimensions = EMBEDDING_DIMENSIONS } = {}) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("embedText requires non-empty text");
  }

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({ inputText: text, dimensions, normalize: true }),
  });

  let response;
  try {
    response = await bedrock.send(command);
  } catch (err) {
    logger.error("Titan embedding call failed", {
      modelId: MODEL_ID,
      error: err?.message,
      name: err?.name,
    });
    throw new UpstreamError(`Bedrock embedding call failed: ${err?.message ?? "unknown"}`, 502);
  }

  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.body));
  } catch (err) {
    throw new UpstreamError(`Could not parse Titan embedding response: ${err?.message ?? "unknown"}`, 502);
  }

  if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) {
    logger.error("Titan embedding response had no embedding", { modelId: MODEL_ID });
    throw new UpstreamError("Titan embedding response contained no embedding", 502);
  }

  return parsed.embedding;
}
