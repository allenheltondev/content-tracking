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
  website?: string | null;
  contactEmail?: string | null;
  notes?: string | null;
  tags?: string[];
  paymentTerms?: string | null;
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
