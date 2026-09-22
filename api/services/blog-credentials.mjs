import { getParameter } from "@aws-lambda-powertools/parameters/ssm";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import { logger } from "./logger.mjs";

// Per-tenant blog platform credentials, stored as a single SSM
// SecureString JSON blob so the secret material never lives in DynamoDB.
// Reads go through Powertools (5-min cache, decrypt on); writes go
// through the SSM client directly. Mirrors api/services/ga-secrets.mjs.
//
// The {env} segment matches the rest of the SSM config (params.mjs,
// ga-secrets.mjs) so the same Lambda code resolves the right value per
// stack. The {tenantId} segment is per-tenant: v1 is single-tenant, but
// the path is scoped so tenant-level IAM (ssm:GetParameter on
// /booked/{env}/tenants/{tenantId}/*) and independent rotation work
// without reshaping the data later.
//
// The JSON value holds one key per platform credential. The keys are the
// platform/publisher names so the publish + analytics adapters can look
// up the value at the platform key directly:
//   {
//     "dev":          "<Dev.to API key>",
//     "medium":       "<Medium integration token>",
//     "medium-cookie":"<logged-in Medium session cookie, for stats>",
//     "hashnode":     "<Hashnode personal access token>"
//   }

const env = process.env.ENVIRONMENT;
if (!env) {
  throw new Error("ENVIRONMENT env var is not set");
}

const ssm = new SSMClient();

export function blogCredentialsParam(tenantId) {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("tenantId is required to resolve blog credentials");
  }
  return `/booked/${env}/tenants/${tenantId}/blog-credentials`;
}

// Powertools / the SDK throw when a parameter doesn't exist. Treat that as
// "not configured yet" rather than an error so callers can report the
// unconfigured state on a fresh stack / new tenant.
function isNotFound(err) {
  let current = err;
  for (let i = 0; i < 5 && current; i++) {
    if (current.name === "ParameterNotFound" || /ParameterNotFound/.test(current.message ?? "")) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

// Returns the parsed credentials object for a tenant, or null when the
// parameter has not been configured. Throws on malformed JSON or any
// non-"not found" SSM error.
export async function getBlogCredentials(tenantId, { forceFetch = false } = {}) {
  const name = blogCredentialsParam(tenantId);
  let raw;
  try {
    raw = await getParameter(name, { decrypt: true, forceFetch });
  } catch (err) {
    if (isNotFound(err)) return null;
    logger.error("Failed to read blog credentials", { tenantId, error: err?.message });
    throw err;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    logger.error("Blog credentials are not valid JSON", { tenantId, error: err?.message });
    throw new Error(`Blog credentials for tenant ${tenantId} are not valid JSON`, { cause: err });
  }
}

// Convenience for adapters that need a single platform credential. Returns
// null when the tenant has no credentials configured or no value at that
// key. Throws when the credentials exist but the requested key is missing,
// so a misconfigured publish fails with a clear message rather than a
// confusing downstream 401.
export async function getBlogCredential(tenantId, key, opts) {
  const creds = await getBlogCredentials(tenantId, opts);
  if (!creds) return null;
  if (!(key in creds)) {
    throw new Error(`Blog credentials for tenant ${tenantId} are missing key "${key}"`);
  }
  return creds[key];
}

// Applies per-key changes to the stored blob: a string sets that key, null
// removes it, and every key not named is kept. Returns the merged blob.
//
// The settings page saves one platform at a time, so a plain overwrite would
// let saving Hashnode silently erase the Dev.to key. It also has to preserve
// keys the settings page never shows — `medium-cookie` is the Medium stats
// credential, set out of band, and must survive someone saving their Medium
// publish token.
//
// The read is forced past the Powertools cache: merging onto a copy up to five
// minutes stale would resurrect a token the author just cleared. Two saves
// racing can still lose one, which is acceptable for a single author's
// settings page.
export async function mergeBlogCredentials(tenantId, changes) {
  const current = (await getBlogCredentials(tenantId, { forceFetch: true })) ?? {};
  const merged = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  await writeBlogCredentials(tenantId, merged);
  return merged;
}

// Writes the full credentials blob for a tenant. Overwrites any existing
// value; callers editing a subset of keys want mergeBlogCredentials.
export async function writeBlogCredentials(tenantId, credentials) {
  await ssm.send(new PutParameterCommand({
    Name: blogCredentialsParam(tenantId),
    Type: "SecureString",
    Value: JSON.stringify(credentials),
    Overwrite: true,
  }));
}
