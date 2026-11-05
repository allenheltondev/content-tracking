import { z } from "zod";
import { assertCampaignOwned } from "../../../api/domain/campaign.mjs";
import { saveDraftForCampaign } from "../../../api/domain/draft.mjs";
import { attachBrief, reviewCampaignDraft } from "../../../api/services/brief-pipeline.mjs";
import { BadRequestError } from "../../../api/services/errors.mjs";
import { validateBriefSubmission } from "../../../api/validation/brief.mjs";
import { formatDraft, validateDraftSubmission } from "../../../api/validation/draft.mjs";
import { WRITE, anyObject, guarded, id } from "../shared.mjs";

// The brief -> draft -> review loop. Briefs go in as text (a pasted brief
// or the sponsor conversation); file uploads (PDF, DOCX) stay in the
// dashboard because they go through a presigned S3 upload.

export function registerWorkflowTools(server, { tenantId }) {
  server.registerTool(
    "attach_campaign_brief",
    {
      title: "Attach campaign brief",
      description:
        "Attach the sponsor's brief to a campaign. Pass the brief as text, or the sponsor conversation as messages. Booked summarizes it and suggests campaign fields (dates, payout, deliverables) to apply with update_campaign. Replaces any earlier brief.",
      inputSchema: z.object({
        campaign_id: id("campaign"),
        text: z.string().optional().describe("The brief as plain text."),
        conversation: z
          .array(
            z.object({
              role: z.enum(["vendor", "influencer", "user", "assistant"]),
              content: z.string().min(1),
            }),
          )
          .optional()
          .describe("The sponsor conversation, oldest first. Use instead of text."),
      }),
      outputSchema: z.object({ summary: z.unknown(), suggested_campaign: anyObject, warnings: z.array(z.unknown()) }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    guarded(async ({ campaign_id: campaignId, text, conversation }) => {
      if (Boolean(text) === Boolean(conversation)) {
        throw new BadRequestError("Pass either text or conversation.");
      }
      await assertCampaignOwned(campaignId, tenantId);
      const submission = validateBriefSubmission({
        source_type: "chat",
        conversation: conversation ?? [{ role: "vendor", content: text }],
      });
      const { summary, suggested_campaign: suggested, warnings } = await attachBrief({
        campaignId,
        tenantId,
        submission,
      });
      return { summary, suggested_campaign: suggested ?? {}, warnings: warnings ?? [] };
    }),
  );

  server.registerTool(
    "save_campaign_draft",
    {
      title: "Save campaign draft",
      description:
        "Save the link to the campaign's working draft (a Google Doc shared for viewing). Replaces any earlier draft link and clears its review.",
      inputSchema: z.object({ campaign_id: id("campaign"), url: z.string() }),
      outputSchema: z.object({ draft: anyObject }),
      annotations: { ...WRITE, idempotentHint: true },
    },
    guarded(async ({ campaign_id: campaignId, url }) => {
      await assertCampaignOwned(campaignId, tenantId);
      const { url: cleanUrl, docId } = validateDraftSubmission({ url });
      return { draft: formatDraft(await saveDraftForCampaign({ campaignId, url: cleanUrl, docId })) };
    }),
  );

  server.registerTool(
    "review_campaign_draft",
    {
      title: "Review campaign draft",
      description:
        "Review the saved draft against the campaign's brief and store the feedback. Needs a saved Google Docs draft and an attached brief. Takes a few seconds.",
      inputSchema: z.object({ campaign_id: id("campaign") }),
      outputSchema: z.object({ draft: anyObject }),
      annotations: { ...WRITE, idempotentHint: true, openWorldHint: true },
    },
    guarded(async ({ campaign_id: campaignId }) => {
      await assertCampaignOwned(campaignId, tenantId);
      return { draft: formatDraft(await reviewCampaignDraft(campaignId)) };
    }),
  );
}
