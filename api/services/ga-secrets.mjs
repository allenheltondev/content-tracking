import { getParameter } from "@aws-lambda-powertools/parameters/ssm";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import { logger } from "./logger.mjs";

// Per-deployment Google credentials, stored as SSM SecureStrings so the
// secret material never lives in DynamoDB. Reads go through Powertools
// (5-min cache, decrypt on); writes go through the SSM client directly.
// The {env} segment matches the rest of the SSM config in params.mjs so
// the same Lambda code resolves the right value per stack.
//
// Three secrets:
//   - GA4 service-account JSON (granted Viewer on the GA4 property)
//   - CrUX / PageSpeed Insights API key (Core Web Vitals)
//   - YouTube Data API key (public video stats for YouTube deliverables)

const env = process.env.ENVIRONMENT;
if (!env) {
  throw new Error("ENVIRONMENT env var is not set");
}

const GA4_SERVICE_ACCOUNT_PARAM = `/booked/${env}/ga4/service-account`;
const CRUX_API_KEY_PARAM = `/booked/${env}/crux/api-key`;
const YOUTUBE_API_KEY_PARAM = `/booked/${env}/youtube/api-key`;

const ssm = new SSMClient();

// Powertools / the SDK throw when a parameter doesn't exist. Treat that as
// "not configured yet" rather than an error so GET /profile can report the
// unconfigured state on a fresh stack.
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

export async function readGa4ServiceAccount({ forceFetch = false } = {}) {
  try {
    const raw = await getParameter(GA4_SERVICE_ACCOUNT_PARAM, { decrypt: true, forceFetch });
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    logger.error("Failed to read GA4 service account", { error: err?.message });
    throw err;
  }
}

export async function readCruxApiKey({ forceFetch = false } = {}) {
  try {
    return (await getParameter(CRUX_API_KEY_PARAM, { decrypt: true, forceFetch })) ?? null;
  } catch (err) {
    if (isNotFound(err)) return null;
    logger.error("Failed to read CrUX API key", { error: err?.message });
    throw err;
  }
}

export async function readYoutubeApiKey({ forceFetch = false } = {}) {
  try {
    return (await getParameter(YOUTUBE_API_KEY_PARAM, { decrypt: true, forceFetch })) ?? null;
  } catch (err) {
    if (isNotFound(err)) return null;
    logger.error("Failed to read YouTube API key", { error: err?.message });
    throw err;
  }
}

export async function writeGa4ServiceAccount(serviceAccount) {
  await ssm.send(new PutParameterCommand({
    Name: GA4_SERVICE_ACCOUNT_PARAM,
    Type: "SecureString",
    Value: JSON.stringify(serviceAccount),
    Overwrite: true,
  }));
}

export async function writeCruxApiKey(key) {
  await ssm.send(new PutParameterCommand({
    Name: CRUX_API_KEY_PARAM,
    Type: "SecureString",
    Value: key,
    Overwrite: true,
  }));
}

export async function writeYoutubeApiKey(key) {
  await ssm.send(new PutParameterCommand({
    Name: YOUTUBE_API_KEY_PARAM,
    Type: "SecureString",
    Value: key,
    Overwrite: true,
  }));
}
