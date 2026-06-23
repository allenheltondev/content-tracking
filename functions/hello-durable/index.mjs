import { withDurableExecution } from "@aws/durable-execution-sdk-js";

// Minimal durable function that proves out the build / deploy / replay
// path before the real blog orchestration (cross-post + weekly analytics)
// is built on top of it. It runs one step, suspends with a wait (no
// compute charge while paused), then runs a second step.
//
// On resume after the wait, Lambda replays the handler from the top and
// substitutes the first step's *stored* result instead of re-running it —
// which is why work must live inside `context.step(...)` and the handler
// body must stay deterministic.
//
// The durable wiring lives in template.yaml: `DurableConfig` enables
// durable execution, `AWSLambdaBasicDurableExecutionRolePolicy` grants
// the checkpoint permissions, and `AutoPublishAlias` gives the qualified
// ARN durable functions require for invocation (never invoke $LATEST).
export const handler = withDurableExecution(async (event, context) => {
  const name = event?.name ?? "world";

  const greeting = await context.step(async (stepContext) => {
    stepContext.logger.info("building greeting", { name });
    return `hello, ${name}`;
  });

  // Short wait to exercise checkpoint + replay. Real workflows wait far
  // longer (the cross-post stagger spans days) at no compute cost.
  await context.wait({ seconds: 5 });

  const result = await context.step(async (stepContext) => {
    stepContext.logger.info("finalizing greeting", { greeting });
    return { message: greeting, durable: true };
  });

  return result;
});
