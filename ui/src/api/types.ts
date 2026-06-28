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

export interface VendorReportPeriod {
  startDate: string;
  endDate: string;
  label: string;
}

export interface VendorReportSummary {
  totalBookedAmount: number;
  totalReceivedAmount: number;
  outstandingAmount: number;
  campaignCount: number;
  paidCount: number;
  unpaidCount: number;
}

// Response from POST /vendors/:vendorId/report — a freshly generated,
// frozen report plus the CloudFront signed link to its static HTML.
export interface VendorReportResponse {
  reportId: string;
  url: string;
  expiresAt: string;
  dataAsOf: string;
  period: VendorReportPeriod;
  currency: string;
  summary: VendorReportSummary;
}

// One row from GET /vendors/:vendorId/reports. The list re-signs a fresh
// `url` per call so a previously generated report can be re-shared without
// regenerating it.
export interface VendorReportListItem {
  reportId: string;
  generatedAt: string;
  dataAsOf: string;
  period: VendorReportPeriod;
  currency: string;
  url: string;
  expiresAt: string;
}

export interface VendorReportsListResponse {
  vendor_id: string;
  reports: VendorReportListItem[];
}

export interface CampaignReportSummary {
  totalClicks: number;
  linkCount: number;
  upstreamFailures: number;
}

// Response from POST /campaigns/:campaignId/report — a freshly generated,
// frozen performance report plus the CloudFront signed link to its static
// HTML and a shortlink wrapper. `shortUrl` is null when the shortlink
// mint failed; callers should fall back to `url` in that case.
export interface CampaignReportResponse {
  reportId: string;
  url: string;
  shortUrl: string | null;
  expiresAt: string;
  dataAsOf: string;
  summary: CampaignReportSummary;
}

// One row from GET /campaigns/:campaignId/reports. The list re-signs a fresh
// `url` per call so a previously generated report can be re-shared without
// regenerating it.
export interface CampaignReportListItem {
  reportId: string;
  generatedAt: string;
  dataAsOf: string;
  url: string;
  expiresAt: string;
}

export interface CampaignReportsListResponse {
  campaign_id: string;
  reports: CampaignReportListItem[];
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

// The campaign's primary deliverable: a published blog post (tracked via GA4
// + Core Web Vitals) or a YouTube video (tracked via the YouTube Data API).
// Mutually exclusive — a campaign is one or the other.
export type DeliverableType = 'blog' | 'youtube';

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
  deliverable_type: DeliverableType;
  blog_url: string | null;
  youtube_url: string | null;
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

export type SocialPlatform = 'twitter' | 'linkedin' | 'instagram' | 'bluesky';

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

// A daily engagement snapshot for one social post. The metric values are
// cumulative-to-that-day totals (likes, comments, etc., platform-specific).
// `snapshot_date` is the UTC calendar day; only the last write of the day
// is kept on the server.
export interface SocialPostSnapshot {
  snapshot_date: string;
  metrics: Record<string, number>;
  captured_at: string | null;
  recorded_at: string;
}

export interface SocialPostSnapshotsResponse {
  campaign_id: string;
  post_id: string;
  snapshots: SocialPostSnapshot[];
}

export type ContentPlatform = 'medium' | 'devto';

// A long-form content piece (Medium, dev.to) the user cross-posted. Same
// shape as SocialPost but in the content metric bucket — engagement is
// captured by the Chrome extension off each platform's analytics traffic
// and reported separately from social engagement.
export interface ContentPost {
  campaign_id: string;
  post_id: string;
  platform: ContentPlatform;
  url: string;
  notes: string | null;
  analytics: Record<string, number> | null;
  last_fetched: string | null;
  captured_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface CreateContentPostRequest {
  url: string;
  platform?: ContentPlatform;
  notes?: string;
}

// A daily engagement snapshot for one content post. Same shape as
// SocialPostSnapshot so the dashboard's charting helpers can be reused.
export interface ContentPostSnapshot {
  snapshot_date: string;
  metrics: Record<string, number>;
  captured_at: string | null;
  recorded_at: string;
}

export interface ContentPostSnapshotsResponse {
  campaign_id: string;
  post_id: string;
  snapshots: ContentPostSnapshot[];
}

export interface CampaignDetailResponse {
  campaign: Campaign;
  links: CampaignLink[];
  social_posts: SocialPost[];
  content_posts: ContentPost[];
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
  link_id: string | null;
  code: string;
  short_url: string | null;
  role: string | null;
  platform: string | null;
  url: string | null;
  src: string | null;
  total_clicks: number;
  by_day: Record<string, number>;
  by_src: Record<string, number>;
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
  by_src: Record<string, number>;
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
  deliverable_type?: DeliverableType;
  blog_url?: string;
  youtube_url?: string;
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
  deliverable_type?: DeliverableType;
  blog_url?: string;
  youtube_url?: string;
  link_tracking_id?: string;
}

// GET /profile — integration settings. Secrets are never returned; only
// whether each integration is configured.
// One social platform the creator is on, shown on the media kit.
export interface ProfileSocialAccount {
  platform: string;
  handle: string | null;
  url: string | null;
  followers: number | null;
}

// A single priced deliverable in the rate card.
export interface ProfileRateCardItem {
  deliverable: string;
  description: string | null;
  price: number | null;
  currency: string;
}

export interface ProfileTestimonial {
  quote: string;
  author: string | null;
  role: string | null;
  company: string | null;
}

export interface ProfileFeaturedCollaboration {
  brand: string;
  description: string | null;
  url: string | null;
  year: number | null;
}

// Audience demographics. Age/gender are label -> percent maps; countries
// are an ordered list. All percentages are 0-100.
export interface ProfileAudience {
  ageBrackets?: Record<string, number> | null;
  gender?: Record<string, number> | null;
  topCountries?: { country: string; percent: number }[] | null;
  note?: string | null;
}

export interface ProfileResponse {
  brand: {
    name: string | null;
    website_url: string | null;
  };
  identity: {
    display_name: string | null;
    tagline: string | null;
    bio: string | null;
    location: string | null;
    contact_email: string | null;
    accent_color: string | null;
    niches: string[];
    avatar_key: string | null;
    avatar_url: string | null;
    logo_key: string | null;
    logo_url: string | null;
  };
  social_accounts: ProfileSocialAccount[];
  audience: ProfileAudience | null;
  rate_card: ProfileRateCardItem[];
  testimonials: ProfileTestimonial[];
  featured_collaborations: ProfileFeaturedCollaboration[];
  public_media_kit: {
    slug: string | null;
    published: boolean;
    url: string | null;
    published_at: string | null;
  };
  ga4: {
    property_id: string | null;
    service_account_email: string | null;
    configured: boolean;
  };
  core_web_vitals: {
    configured: boolean;
  };
  youtube: {
    configured: boolean;
  };
  updated_at: string | null;
}

// PUT /profile — all fields optional; only the ones present are applied.
// Explicit null clears a nullable field (mirrors the API's contract).
export interface ProfileUpdateRequest {
  ga4_property_id?: string;
  // The full service-account JSON, pasted from the downloaded key file.
  ga4_service_account?: string;
  crux_api_key?: string;
  // A Google API key with the YouTube Data API v3 enabled.
  youtube_api_key?: string;
  brand_name?: string;
  website_url?: string;
  display_name?: string | null;
  tagline?: string | null;
  bio?: string | null;
  location?: string | null;
  contact_email?: string | null;
  accent_color?: string | null;
  public_slug?: string | null;
  niches?: string[] | null;
  avatar_key?: string | null;
  logo_key?: string | null;
  social_accounts?: ProfileSocialAccount[] | null;
  audience?: ProfileAudience | null;
  rate_card?: ProfileRateCardItem[] | null;
  testimonials?: ProfileTestimonial[] | null;
  featured_collaborations?: ProfileFeaturedCollaboration[] | null;
}

export type ProfileImageKind = 'avatar' | 'logo';

export interface ProfileImageUploadResponse {
  kind: ProfileImageKind;
  key: string;
  url: string;
  expiresAt: string;
}

// Aggregate performance stats baked into a generated media kit.
export interface MediaKitStats {
  totalFollowers: number;
  platformCount: number;
  campaignsCompleted: number;
  campaignsTotal: number;
  postsTracked: number;
  totalViews: number;
  totalImpressions: number;
  totalReach: number;
  totalEngagements: number;
  engagementRate: number | null;
}

export interface MediaKitGenerateResponse {
  reportId: string;
  url: string;
  shortUrl: string | null;
  expiresAt: string;
  dataAsOf: string;
  stats: MediaKitStats;
}

export interface MediaKitListItem {
  reportId: string;
  generatedAt: string;
  dataAsOf: string;
  stats: MediaKitStats | null;
  url: string;
  expiresAt: string;
}

export interface MediaKitListResponse {
  media_kits: MediaKitListItem[];
}

// State of the public, brand-facing media kit published to a stable
// vanity URL.
export interface MediaKitPublishState {
  slug: string | null;
  published: boolean;
  url: string | null;
  published_at: string | null;
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

export interface YoutubeTotals {
  views: number;
  likes: number;
  comments: number;
  favorites: number;
}

// Public stats for a campaign's YouTube video deliverable. `configured` is
// false when no YouTube Data API key is stored; `error` is non-null when
// configured but the fetch failed (or the video is private). `totals` and
// the snippet fields are present only on a successful fetch.
export interface YoutubeSection {
  configured: boolean;
  error: string | null;
  youtube_url?: string;
  video_id?: string;
  title?: string | null;
  channel_title?: string | null;
  published_at?: string | null;
  thumbnail_url?: string | null;
  totals?: YoutubeTotals;
}

// GET /campaigns/:id/web-analytics. The shape depends on the campaign's
// `deliverable_type`: a blog campaign carries ga4 + core_web_vitals (keyed
// off blog_url); a youtube campaign carries the youtube section.
export interface WebAnalyticsResponse {
  campaign_id: string;
  deliverable_type: DeliverableType;
  blog_url?: string;
  page_path?: string;
  range?: { startDate: string; endDate: string };
  ga4?: Ga4Section;
  core_web_vitals?: CoreWebVitalsSection;
  youtube?: YoutubeSection;
}

// Account-wide Trends & Insights (GET /insights). Cumulative engagement
// levels over time plus top performers and period-over-period deltas.
export interface InsightsMetricTriple {
  views: number;
  impressions: number;
  engagements: number;
}

export interface InsightsTimeseriesPoint extends InsightsMetricTriple {
  date: string;
}

export interface InsightsTopPost extends InsightsMetricTriple {
  platform: string | null;
  kind: 'social' | 'content';
  url: string | null;
  campaignId: string;
  campaignName: string | null;
  lastCaptured: string | null;
}

export interface InsightsPlatformRow extends InsightsMetricTriple {
  platform: string;
}

export interface InsightsResponse {
  range: { startDate: string; endDate: string; days: number };
  totals: InsightsMetricTriple & {
    reach: number;
    engagementRate: number | null;
    postsTracked: number;
  };
  deltas: {
    thisPeriod: InsightsMetricTriple;
    priorPeriod: InsightsMetricTriple;
    changePct: {
      views: number | null;
      impressions: number | null;
      engagements: number | null;
    };
  };
  timeseries: InsightsTimeseriesPoint[];
  topPosts: InsightsTopPost[];
  byPlatform: InsightsPlatformRow[];
}

// On-demand engagement recommendations for a single content post: where else
// to cross-post or promote it to boost reach. Generated via Bedrock, stored
// on the post, and re-readable without re-spending on the model.
export type RecommendationAction = 'cross_post' | 'promote';
export type RecommendationPriority = 'high' | 'medium' | 'low';

export interface EngagementRecommendationItem {
  channel: string;
  action: RecommendationAction;
  priority: RecommendationPriority;
  rationale: string;
  suggested_message: string;
}

export interface EngagementRecommendation {
  campaign_id: string;
  post_id: string;
  summary: string | null;
  recommendations: EngagementRecommendationItem[];
  already_covered: string[];
  generated_at: string;
}

// Blog catalog RAG Q&A (POST /blogs/ask). The model answers grounded only in
// the creator's own posts; `sources` are the posts the answer drew on.
export type BlogAnswerConfidence = 'high' | 'medium' | 'low';

export interface BlogAnswerSource {
  blog_id: string;
  title: string | null;
  slug: string | null;
}

export interface BlogAnswer {
  answer: string;
  confidence: BlogAnswerConfidence;
  sources: BlogAnswerSource[];
}

// Voice feature (learn + draft in the creator's per-platform writing style).
export type VoiceFormat = 'social' | 'blog';

export interface VoiceDraft {
  post: string;
  title: string | null;
}

export interface VoiceSample {
  sample_id: string;
  platform: string;
  format: string | null;
  source: string | null;
  text: string;
  created_at: string;
}

export interface VoiceProfile {
  platform: string;
  profile: Record<string, unknown> | null;
  samples_since_reflection: number;
  reflection_threshold: number;
  version: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface VoiceReflection {
  reflection_id: string;
  platform: string;
  change_summary: string | null;
  sample_window: number | null;
  model: string | null;
  created_at: string;
}

// Blog catalog management (the /blogs CRUD + cross-post surface).
export interface BlogSummary {
  blog_id: string;
  title: string;
  slug: string;
  description: string | null;
  image: string | null;
  image_attribution: string | null;
  tags: string[];
  categories: string[];
  canonical_url: string | null;
  campaign_id: string | null;
  links: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface Blog extends BlogSummary {
  content_markdown: string | null;
}

export interface BlogListResponse {
  blogs: BlogSummary[];
  nextStartKey: string | null;
}

// Unified Content catalog (the /content CRUD surface) — the management
// successor to the Blog entity. Bodies are snake_case on the wire and mirror
// the API's validation/content.mjs contract.
export type ContentType = 'blog' | 'social' | 'video';
export type ContentSource = 'owned' | 'sponsored';
export type ContentStatus = 'draft' | 'scheduled' | 'published' | 'archived';

// List representation: omits content_markdown so a content list doesn't ship
// every item's full body.
export interface ContentSummary {
  content_id: string;
  type: ContentType | null;
  source: ContentSource | null;
  title: string;
  slug: string;
  description: string | null;
  status: ContentStatus | null;
  tags: string[];
  categories: string[];
  canonical_url: string | null;
  campaign_id: string | null;
  links: Record<string, string>;
  created_at: string;
  updated_at: string;
}

// Full representation (single-content reads) — adds the markdown body.
export interface Content extends ContentSummary {
  content_markdown: string | null;
}

export interface ContentListResponse {
  content: ContentSummary[];
  nextStartKey: string | null;
}

// Body for POST /content. type/title/slug/content_markdown are required;
// source + status default server-side (owned / draft) when omitted.
export interface CreateContentParams {
  type: ContentType;
  source?: ContentSource;
  title: string;
  slug: string;
  description?: string;
  content_markdown: string;
  status?: ContentStatus;
  tags?: string[];
  categories?: string[];
  canonical_url?: string;
  campaign_id?: string;
}

// Body for PATCH /content/:contentId. All fields optional; an explicit null
// clears a clearable field (description, canonical_url, tags, categories,
// campaign_id), mirroring the API's update contract.
export interface UpdateContentParams {
  type?: ContentType;
  source?: ContentSource;
  title?: string;
  slug?: string;
  description?: string | null;
  content_markdown?: string;
  status?: ContentStatus;
  tags?: string[] | null;
  categories?: string[] | null;
  canonical_url?: string | null;
  campaign_id?: string | null;
}

// Content catalog RAG Q&A (POST /content/ask). The model answers grounded
// only in the creator's own content; `sources` are the pieces it drew on.
export type ContentAnswerConfidence = 'high' | 'medium' | 'low';

export interface ContentAnswerSource {
  content_id: string;
  title: string | null;
  slug: string | null;
  type: ContentType | null;
}

export interface ContentAnswer {
  answer: string;
  confidence: ContentAnswerConfidence;
  sources: ContentAnswerSource[];
}

export type CrosspostPlatform = 'dev' | 'medium' | 'hashnode';

export interface CrosspostRun {
  run_id: string;
  status: string;
  platforms: { platform: string; delay_seconds?: number }[];
  started_at: string | null;
  completed_at: string | null;
}

export interface CrosspostCopy {
  platform: string;
  status: string;
  url: string | null;
  id: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  error: string | null;
}

export interface CrosspostStatus {
  run: CrosspostRun | null;
  platforms: CrosspostCopy[];
}
