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

export interface BriefResponse {
  brief_id: string;
  source_type: 'pdf' | 'chat';
  summary: string;
  suggested_campaign: SuggestedCampaign;
  warnings: string[];
  campaign_id: string | null;
}

export interface UploadUrlResponse {
  brief_id: string;
  upload_url: string;
  s3_key: string;
  expires_at: string;
}

export interface ConfirmResponse {
  brief_id: string;
  campaign_id: string;
  already_confirmed: boolean;
}

export interface BriefDetailResponse {
  brief_id: string;
  source_type: 'pdf' | 'chat';
  summary: string;
  suggested_campaign: SuggestedCampaign;
  warnings: string[];
  campaign_id: string | null;
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

export type CampaignStatus = 'draft' | 'active' | 'completed';

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

export interface CampaignDetailResponse {
  campaign: Campaign;
  links: CampaignLink[];
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

export interface ConfirmRequest {
  name: string;
  sponsor?: string;
  vendor_id?: string;
  startDate?: string;
  endDate?: string;
  status?: 'draft' | 'active' | 'completed';
  deliverables?: Deliverable[];
  payout?: PayoutFields;
  targetMetrics?: Record<string, unknown>;
}
