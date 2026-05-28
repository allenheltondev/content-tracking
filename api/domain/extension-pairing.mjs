import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { TABLE_NAME, ddb } from "../services/ddb.mjs";
import { NotFoundError } from "../services/errors.mjs";
import { newJti, signToken } from "../services/extension-token.mjs";

// Pairing tokens issued to the Chrome extension. The dashboard mints
// them on the Settings → Extension page; the user pastes the token into
// the extension's Options. The token itself is signed (HMAC-SHA256) so
// the API authorizer can verify it without a database hit; the metadata
// row written here exists so the authorizer can also confirm the jti
// hasn't been revoked, and so the dashboard can list/revoke the user's
// active pairings.
//
// Storage:
//   pk = USER#{cognitoSub}, sk = EXTTOKEN#{jti}
//   entity = "ExtensionPairing"
//
// Only the metadata is persisted — the token value itself is returned
// once at mint time and never stored anywhere on our side.

const SK_PREFIX = "EXTTOKEN#";

function pairingKey(sub, jti) {
  return { pk: `USER#${sub}`, sk: `${SK_PREFIX}${jti}` };
}

export async function mintPairing({ sub, label, signingSecret }) {
  if (!sub) {
    throw new Error("mintPairing requires sub.");
  }
  if (!signingSecret) {
    throw new Error("mintPairing requires signingSecret.");
  }
  const jti = newJti();
  const now = new Date().toISOString();
  const item = {
    ...pairingKey(sub, jti),
    entity: "ExtensionPairing",
    jti,
    sub,
    label: label?.trim() || "Unnamed device",
    created_at: now,
    last_used_at: null,
  };
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: "attribute_not_exists(pk)",
  }));

  const token = signToken({ sub, jti, secret: signingSecret });
  return { pairing: toPublic(item), token };
}

export async function listPairings({ sub }) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
    ExpressionAttributeValues: {
      ":pk": `USER#${sub}`,
      ":sk": SK_PREFIX,
    },
  }));
  return (result.Items ?? []).map(toPublic);
}

export async function revokePairing({ sub, jti }) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: pairingKey(sub, jti),
      ConditionExpression: "attribute_exists(pk)",
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      throw new NotFoundError("ExtensionPairing", jti);
    }
    throw err;
  }
}

// Authorizer-side: returns the pairing item if it still exists, null if
// it has been revoked. Side-effects last_used_at so the dashboard can
// show "Last used 3 minutes ago." Best-effort; failures don't break
// auth.
export async function touchPairing({ sub, jti }) {
  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: pairingKey(sub, jti),
      UpdateExpression: "SET last_used_at = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":now": new Date().toISOString() },
      ReturnValues: "ALL_NEW",
    }));
    return result.Attributes ?? null;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      return null;
    }
    throw err;
  }
}

// Strip internal partition keys before sending to the dashboard.
function toPublic(item) {
  return {
    jti: item.jti,
    label: item.label,
    created_at: item.created_at,
    last_used_at: item.last_used_at,
  };
}
