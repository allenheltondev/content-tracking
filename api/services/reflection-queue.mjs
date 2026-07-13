import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { logger } from "./logger.mjs";

// The "trailing reflection" timer for the voice pipeline. Reflection is
// coalesced under bursty ingress by a cooldown + atomic claim (see
// voice-memory.mjs / domain claimReflectionSlot), which collapses a stampede of
// per-sample reflections into at most one per cooldown window. But a cooldown
// alone has a trailing-edge gap: if a burst of samples all land inside one
// cooldown window and then ingress goes silent, the last window's samples are
// captured but never reflected (no later sample arrives to trigger it).
//
// This queue closes that gap. Each reflection that runs enqueues a single
// delayed catch-up message (delay ≈ cooldown); when it fires, VoiceMemoryFunction
// re-attempts a coalesced reflection. If the profile is still dirty it reflects
// the tail and enqueues one more catch-up; once it's converged (nothing new to
// reflect) the claim fails and the chain self-terminates. So a bulk backfill
// converges within ~one cooldown of its last write with no manual step.
//
// When the queue URL isn't configured (local dev / tests) this degrades to a
// logged no-op: reflection still works via the cooldown, just without the
// trailing catch-up.

const QUEUE_URL = process.env.VOICE_REFLECTION_QUEUE_URL;
const client = new SQSClient({});

// SQS per-message delay is capped at 15 minutes.
const MAX_DELAY_SECONDS = 900;

export async function enqueueReflectionCatchup({ tenantId, platform, delaySeconds = 60 }) {
  if (!QUEUE_URL) {
    logger.info("VOICE_REFLECTION_QUEUE_URL unset; skipping reflection catch-up", { platform });
    return { skipped: true };
  }
  const delay = Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.round(delaySeconds)));
  await client.send(new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify({ type: "reflection-catchup", tenantId, platform }),
    DelaySeconds: delay,
  }));
  logger.info("Enqueued reflection catch-up", { platform, delay });
  return { enqueued: true };
}
