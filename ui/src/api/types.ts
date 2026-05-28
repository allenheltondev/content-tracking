export interface Deliverable {
  platform: string;
  type: string;
  count?: number;
  notes?: string;
}

export interface SuggestedPayout {
  amount?: number;
  currency?: string;
}

export interface SuggestedCampaign {
  name?: string;
  vendor?: { name_hint?: string };
  vendor_id?: string;
  startDate?: string;
  endDate?: string;
  deliverables?: Deliverable[];
  payout?: SuggestedPayout;
  targetMetrics?: Record<string, unknown>;
}

// Returned by POST /campaigns/:campaignId/brief after the model summarizes
// the brief and it's stored on the campaign.
export interface BriefResponse {
  campaign_id: string;
  source_type: 'pdf' | 'chat';
  summary: string;
  suggested_campaign: SuggestedCampaign;
  warnings: string[];
}

export interface UploadUrlResponse {
  upload_url: string;
  s3_key: string;
  expires_at: string;
}

// The brief attached to a campaign, as embedded in CampaignDetailResponse.
export interface CampaignBrief {
  source_type: 'pdf' | 'chat';
  summary: string;
  suggested_campaign: SuggestedCampaign;
  warnings: string[];
  raw: { download_url: string } | null;
  created_at: string;
}

export interface Vendor {
  vendor_id: string;
  name: string;
  website: string | null;
  contact_name: string | null;
  contact_email: string | null;
  payment_terms: string | null;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at?: string;
}

export interface VendorPayload {
  vendor_id?: string;
  name?: string;
  website?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  payment_terms?: string | null;
  tags?: string[] | null;
  notes?: string | null;
}

export interface VendorCampaignSummary {
  campaign_id: string;
  name: string;
  status: 'draft' | 'active' | 'completed';
  startDate: string | null;
  endDate: string | null;
  created_at: string;
}

export interface VendorCampaignsResponse {
  vendor_id: string;
  campaigns: VendorCampaignSummary[];
}

export interface RevenueAggregate {
  amount: number;
  campaignCount: number;
}

export interface RevenueGroup {
  key: string;
  amount: number;
  campaignCount: number;
  bookedAmount: number;
  bookedCount: number;
  receivedAmount: number;
  receivedCount: number;
}

export interface RevenueResponse {
  currency: string;
  range: { startDate: string; endDate: string };
  total: RevenueAggregate;
  booked: RevenueAggregate;
  received: RevenueAggregate;
  groups: RevenueGroup[];
  skipped: { campaign_id: string; currency: string; amount: number; reason: string }[];
}

export type CampaignStatus = 'draft' | 'active' | 'monitoring' | 'completed';

export interface Campaign {
  campaign_id: string;
  name: string;
  sponsor: string | null;
  vendor_id: string | null;
  startDate: string | null;
  endDate: string | null;
  status: CampaignStatus;
  targetMetrics: Record<string, unknown> | null;
  payout: {
    amount: number;
    currency: string;
    paid: boolean;
    paid_at: string | null;
    invoice_ref: string | null;
  } | null;
  blog_url: string | null;
  link_tracking_id: string | null;
  created_at: string;
}

export interface CampaignListResponse {
  campaigns: Campaign[];
  nextStartKey?: string;
}

export interface CampaignLink {
  link_id: string;
  code: string;
  short_url: string;
  role: 'main' | 'cross_post' | 'social_promo';
  platform: string;
  url: string;
  src: string | null;
  notes: string | null;
  expires_at: string;
  created_at: string;
}

export type SocialPlatform = 'twitter' | 'linkedin' | 'instagram';

// A published post on a social platform. Engagement metrics are written
// back by the Chrome extension; `last_fetched` is the server timestamp of
// the most recent metrics write.
export interface SocialPost {
  campaign_id: string;
  post_id: string;
  platform: SocialPlatform;
  url: string;
  notes: string | null;
  analytics: Record<string, number> | null;
  last_fetched: string | null;
  captured_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface CreateSocialPostRequest {
  url: string;
  platform?: SocialPlatform;
  notes?: string;
}

export interface CampaignDetailResponse {
  campaign: Campaign;
  links: CampaignLink[];
  social_posts: SocialPost[];
  brief: CampaignBrief | null;
  draft: CampaignDraft | null;
}

export type DraftVerdict = 'ready' | 'minor_revisions' | 'major_revisions';
export type DraftIssueSeverity = 'high' | 'medium' | 'low';

export interface DraftReviewIssue {
  severity: DraftIssueSeverity;
  area?: string;
  detail: string;
  suggestion?: string;
}

export interface DraftReview {
  verdict: DraftVerdict;
  summary: string;
  brief_alignment?: string;
  strengths?: string[];
  issues?: DraftReviewIssue[];
  missing_requirements?: string[];
}

export interface CampaignDraft {
  url: string;
  doc_id: string | null;
  review: DraftReview | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveDraftRequest {
  url: string;
}

export interface CampaignAnalyticsLink {
  link_id: string;
  code: string;
  role: string;
  platform: string;
  url: string;
  total_clicks: number;
  first_click_at: string | null;
  last_click_at: string | null;
  error: string | null;
}

export interface CampaignAnalyticsResponse {
  campaign_id: string;
  link_count: number;
  total_clicks: number;
  by_role: Record<string, number>;
  by_platform: Record<string, number>;
  by_day: Record<string, number>;
  upstream_failures: number;
  links: CampaignAnalyticsLink[];
}

export interface CreateCampaignRequest {
  name: string;
  sponsor?: string;
  vendor_id?: string;
  startDate?: string;
  endDate?: string;
  status?: CampaignStatus;
  targetMetrics?: Record<string, unknown>;
  blog_url?: string;
  link_tracking_id?: string;
}

export interface CreateLinkRequest {
  role: 'main' | 'cross_post' | 'social_promo';
  platform: string;
  url: string;
  src?: string;
  notes?: string;
  expiresInDays?: number;
}

export interface VendorListResponse {
  vendors: Vendor[];
  nextStartKey?: string;
}

export type ChatRole = 'vendor' | 'influencer' | 'user' | 'assistant';

export interface ChatEntry {
  role: ChatRole;
  content: string;
}

export interface PayoutFields {
  amount: number;
  currency: string;
  paid: boolean;
}

// Fields a user can apply to an existing campaign from a brief's
// suggestions (PATCH /campaigns/:campaignId). All optional.
export interface UpdateCampaignRequest {
  name?: string;
  sponsor?: string;
  vendor_id?: string;
  startDate?: string;
  endDate?: string;
  status?: CampaignStatus;
  payout?: PayoutFields;
  targetMetrics?: Record<string, unknown>;
  blog_url?: string;
  link_tracking_id?: string;
}

// GET /profile — integration settings. Secrets are never returned; only
// whether each integration is configured.
export interface ProfileResponse {
  ga4: {
    property_id: string | null;
    service_account_email: string | null;
    configured: boolean;
  };
  core_web_vitals: {
    configured: boolean;
  };
  updated_at: string | null;
}

// PUT /profile — all fields optional; only the ones present are applied.
export interface ProfileUpdateRequest {
  ga4_property_id?: string;
  // The full service-account JSON, pasted from the downloaded key file.
  ga4_service_account?: string;
  crux_api_key?: string;
}

// Chrome-extension pairing tokens. The token value itself only appears
// in the POST response (one-time view); GET only returns metadata so
// nothing on the wire reveals a previously minted token.
export interface ExtensionPairing {
  jti: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ListExtensionPairingsResponse {
  pairings: ExtensionPairing[];
}

export interface CreateExtensionPairingRequest {
  label?: string;
}

export interface CreateExtensionPairingResponse {
  pairing: ExtensionPairing;
  token: string;
}

export interface Ga4Totals {
  pageviews: number;
  users: number;
  sessions: number;
  avg_session_duration: number;
  engagement_rate: number;
  bounce_rate: number;
}

export interface Ga4Section {
  configured: boolean;
  error: string | null;
  property_id?: string;
  page_path?: string;
  range?: { startDate: string; endDate: string };
  totals?: Ga4Totals;
  by_day?: Record<string, number>;
}

export interface WebVitalsMetrics {
  lcp_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  fcp_ms: number | null;
  ttfb_ms?: number | null;
  tbt_ms?: number | null;
}

export interface CoreWebVitalsSection {
  configured: boolean;
  error: string | null;
  source?: 'crux' | 'psi';
  url?: string;
  strategy?: string;
  performance_score?: number | null;
  metrics?: WebVitalsMetrics;
}

export interface WebAnalyticsResponse {
  campaign_id: string;
  blog_url: string;
  page_path: string;
  range: { startDate: string; endDate: string };
  ga4: Ga4Section;
  core_web_vitals: CoreWebVitalsSection;
}
