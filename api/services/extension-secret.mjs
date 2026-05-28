import { getSecret } from "@aws-lambda-powertools/parameters/secrets";

// HMAC signing key for extension pairing tokens. Provisioned by the SAM
// template as an AWS::SecretsManager::Secret with GenerateSecretString,
// so the value rotates only when an operator explicitly rotates it; the
// jti list in DynamoDB is the per-pairing revocation lever.
//
// Read by both the API Lambda (mint) and the authorizer Lambda (verify),
// both of which have GetSecretValue on this ARN granted in template.yaml.

const SECRET_ARN = process.env.EXTENSION_TOKEN_SIGNING_SECRET_ARN;

export async function getExtensionSigningSecret() {
  if (!SECRET_ARN) {
    throw new Error("EXTENSION_TOKEN_SIGNING_SECRET_ARN env var is not set.");
  }
  const value = await getSecret(SECRET_ARN);
  if (!value) {
    throw new Error("Extension signing secret is empty.");
  }
  return value;
}
