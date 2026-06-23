import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { logger } from "./logger.mjs";
import { UpstreamError } from "./errors.mjs";

// Starts a cross-post durable execution by asynchronously invoking the
// crosspost function's alias (durable executions require a qualified ARN).
// The execution runs independently; the API returns immediately and the
// client polls GET /blogs/{id}/crosspost-status.

const CROSSPOST_FUNCTION_ARN = process.env.CROSSPOST_FUNCTION_ARN;

const lambda = new LambdaClient();

export async function startCrosspostExecution(payload) {
  if (!CROSSPOST_FUNCTION_ARN) {
    throw new Error("CROSSPOST_FUNCTION_ARN is not configured");
  }

  const response = await lambda.send(new InvokeCommand({
    FunctionName: CROSSPOST_FUNCTION_ARN,
    InvocationType: "Event", // async: queue + return, durable execution runs on its own
    Payload: Buffer.from(JSON.stringify(payload)),
  }));

  // A queued async invoke returns 202. Anything else means it was not
  // accepted (e.g. throttling, a synchronous function error surfaced).
  if (!response.StatusCode || response.StatusCode >= 300 || response.FunctionError) {
    logger.error("Failed to start cross-post execution", {
      status: response.StatusCode,
      functionError: response.FunctionError,
    });
    throw new UpstreamError("Failed to start cross-post execution", response.StatusCode);
  }

  return { started: true };
}
