import { Logger } from "@aws-lambda-powertools/logger";

// Single Logger instance shared across the API. serviceName comes from
// the POWERTOOLS_SERVICE_NAME env var set in template.yaml, so no
// per-module config needed.
export const logger = new Logger();
