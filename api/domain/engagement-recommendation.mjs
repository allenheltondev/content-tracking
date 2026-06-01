import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";

// The latest engagement recommendation for a single content post lives
// alongside the post under the campaign partition:
//   pk = CAMPAIGN#{campaignId}, sk = CONTENTPOST#{postId}#RECOMMENDATIONS
//
// There's at most one per content post — regenerating replaces the prior
// set, mirroring how a draft's review is overwritten on each re-review. The
// sk shares the CONTENTPOST#{postId} prefix so it rides along on the campaign
// Query, but its distinct `entity` ("ContentPostRecommendation") keeps it out
// of content-post listings (which filter on entity = "ContentPost") and out
// of the snapshot range (sk = ...#SNAPSHOT#{date}).

function recommendationKey(campaignId, postId) {
  return { pk: `CAMPAIGN#${campaignId}`, sk: `CONTENTPOST#${postId}#RECOMMENDATIONS` };
}

// Persists a freshly generated recommendation onto the content post.
// Conditional on the content post existing so a recommendation can't be
// stored for a post that was deleted between the read and the write.
export async function saveEngagementRecommendation(campaignId, postId, recommendation) {
  const now = new Date().toISOString();
  const item = {
    ...recommendationKey(campaignId, postId),
    entity: "ContentPostRecommendation",
    campaignId,
    postId,
    summary: recommendation.summary,
    recommendations: recommendation.recommendations ?? [],
    alreadyCovered: recommendation.already_covered ?? [],
    generatedAt: now,
  };

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      // The content post itself sits at sk = CONTENTPOST#{postId}; this guards
      // the recommendation row, not the post, so callers must verify the post
      // exists before generating. The route does exactly that.
      ConditionExpression: "attribute_not_exists(sk) OR entity = :entity",
      ExpressionAttributeValues: { ":entity": "ContentPostRecommendation" },
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      // Should be unreachable given the entity guard, but surface clearly
      // rather than masking an unexpected collision.
      throw new NotFoundError("ContentPostRecommendation", postId);
    }
    throw err;
  }

  return item;
}

export async function getEngagementRecommendation(campaignId, postId) {
  const result = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: recommendationKey(campaignId, postId),
  }));
  return result.Item ?? null;
}
