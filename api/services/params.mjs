import { getParameter } from "@aws-lambda-powertools/parameters/ssm";

// SSM-backed config. Powertools caches each value for 5 minutes by
// default, so this is a network hit on cold start (or every 5 min of
// continuous traffic) but not per-request.
//
// The {env} segment of each path is the deployment environment
// (staging | production) passed through to the Lambda via the
// ENVIRONMENT variable in template.yaml. Same Lambda code resolves
// the right value in each stack.

const env = process.env.ENVIRONMENT;
if (!env) {
  throw new Error("ENVIRONMENT env var is not set");
}

export async function getNewsletterApiBaseUrl() {
  return getParameter(`/newsletter-service/${env}/newsletter-api-base-url`);
}

export async function getCampaignShortLinkBase() {
  return getParameter(`/newsletter-service/${env}/campaign-short-link-base`);
}
