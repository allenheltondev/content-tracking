import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { useApiFetch, ApiError, type ApiFetch } from '../auth/useApiFetch';
import {
  createContentPost,
  createSocialPost,
  deleteContentPost,
  deleteSocialPost,
  getCampaign,
  getCampaignAnalytics,
  getCampaignWebAnalytics,
  updateCampaign,
} from '../api/campaigns';
import type {
  Campaign,
  CampaignAnalyticsResponse,
  CampaignBrief,
  CampaignDraft,
  CampaignLink,
  CampaignStatus,
  ContentPost,
  CoreWebVitalsSection,
  CreateContentPostRequest,
  CreateSocialPostRequest,
  Ga4Section,
  SocialPost,
  VendorPayload,
  WebAnalyticsResponse,
} from '../api/types';
import { createVendor } from '../api/vendors';
import ClicksChart from '../components/ClicksChart';
import RegisterSocialPostForm from '../components/RegisterSocialPostForm';
import RegisterContentPostForm from '../components/RegisterContentPostForm';
import CampaignBriefSection from '../components/CampaignBriefSection';
import CampaignDraftTab from '../components/CampaignDraftTab';
import ContentEngagementSection from '../components/ContentEngagementSection';
import InstallExtensionModal from '../components/InstallExtensionModal';
import Modal from '../components/Modal';
import SocialEngagementSection from '../components/SocialEngagementSection';
import VendorForm from '../components/VendorForm';
import VendorSelect from '../components/VendorSelect';

type CampaignTab = 'overview' | 'brief' | 'draft' | 'promotion' | 'analytics';

const CAMPAIGN_TABS: readonly CampaignTab[] = [
  'overview',
  'brief',
  'draft',
  'promotion',
  'analytics',
];

interface CampaignBundle {
  campaign: Campaign;
  links: CampaignLink[];
  social_posts: SocialPost[];
  content_posts: ContentPost[];
  brief: CampaignBrief | null;
  draft: CampaignDraft | null;
}

export default function CampaignDetail(): ReactElement {
  const { campaignId } = useParams<{ campaignId: string }>();
  const [searchParams] = useSearchParams();
  const apiFetch = useApiFetch();

  // Honor ?tab=brief (etc) on first render so the "create then upload brief"
  // flow can land users straight on the brief tab. Falls back to overview.
  const initialTab: CampaignTab = (() => {
    const candidate = searchParams.get('tab');
    return CAMPAIGN_TABS.includes(candidate as CampaignTab)
      ? (candidate as CampaignTab)
      : 'overview';
  })();

  const [bundle, setBundle] = useState<CampaignBundle | null>(null);
  const [analytics, setAnalytics] = useState<CampaignAnalyticsResponse | null>(null);
  const [analyticsFetchedAt, setAnalyticsFetchedAt] = useState<Date | null>(null);
  const [analyticsRefreshing, setAnalyticsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  const [webAnalytics, setWebAnalytics] = useState<WebAnalyticsResponse | null>(null);
  const [webAnalyticsError, setWebAnalyticsError] = useState<string | null>(null);
  const [webAnalyticsLoading, setWebAnalyticsLoading] = useState(false);

  const [postBusy, setPostBusy] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const [showPostForm, setShowPostForm] = useState(false);

  const [contentBusy, setContentBusy] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [showContentForm, setShowContentForm] = useState(false);

  const [activeTab, setActiveTab] = useState<CampaignTab>(initialTab);
  const [extensionModalOpen, setExtensionModalOpen] = useState(false);

  // Campaign metadata + links. Cheap; fires on mount.
  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    setLoadError(null);
    getCampaign(apiFetch, campaignId)
      .then((res) => {
        if (!cancelled) setBundle(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, campaignId]);

  // Analytics. Whether the server takes the per-link fan-out path or the
  // one-shot newsletter-service campaignId rollup depends on the campaign's
  // link_tracking_id, so this re-runs whenever that value changes (e.g.,
  // the user just added one via the inline editor).
  const linkTrackingId = bundle?.campaign.link_tracking_id ?? null;
  const campaignLoaded = bundle !== null;
  useEffect(() => {
    if (!campaignId || !campaignLoaded) return;
    let cancelled = false;
    setAnalyticsError(null);
    getCampaignAnalytics(apiFetch, campaignId)
      .then((res) => {
        if (!cancelled) {
          setAnalytics(res);
          setAnalyticsFetchedAt(new Date());
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setAnalyticsError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, campaignId, campaignLoaded, linkTrackingId]);

  const refreshAnalytics = useCallback(async (): Promise<void> => {
    if (!campaignId) return;
    setAnalyticsRefreshing(true);
    setAnalyticsError(null);
    try {
      const res = await getCampaignAnalytics(apiFetch, campaignId);
      setAnalytics(res);
      setAnalyticsFetchedAt(new Date());
    } catch (err) {
      setAnalyticsError((err as Error).message);
    } finally {
      setAnalyticsRefreshing(false);
    }
  }, [apiFetch, campaignId]);

  // Web analytics (GA4 + Core Web Vitals) only make sense once we know the
  // campaign's blog URL, and the call is slow (it hits Google), so it runs
  // on its own after the campaign loads and only when a blogUrl is set.
  const blogUrl = bundle?.campaign.blog_url ?? null;
  useEffect(() => {
    if (!campaignId || !blogUrl) {
      setWebAnalytics(null);
      return;
    }
    let cancelled = false;
    setWebAnalyticsLoading(true);
    setWebAnalyticsError(null);
    getCampaignWebAnalytics(apiFetch, campaignId)
      .then((res) => {
        if (!cancelled) setWebAnalytics(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setWebAnalyticsError(err.message);
      })
      .finally(() => {
        if (!cancelled) setWebAnalyticsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, campaignId, blogUrl]);

  // Optimistically append a freshly minted link and rerun analytics. The
  // new link has zero clicks so the chart won't change, but link count and
  // tables should reflect it immediately. Shared by the Links form and the
  // brief's per-deliverable short-link creator.
  //
  // The server adopts a "main" role link's destination URL as the
  // campaign's blog_url when blog_url is unset, so mirror that here so
  // the Overview tab updates without a refetch.
  const appendLinkAndRefresh = useCallback(
    (link: CampaignLink): void => {
      setBundle((prev) => {
        if (!prev) return prev;
        const next = { ...prev, links: [...prev.links, link] };
        if (link.role === 'main' && !prev.campaign.blog_url) {
          next.campaign = { ...prev.campaign, blog_url: link.url };
        }
        return next;
      });
      if (!campaignId) return;
      getCampaignAnalytics(apiFetch, campaignId)
        .then((res) => setAnalytics(res))
        .catch((err: Error) => setAnalyticsError(err.message));
    },
    [apiFetch, campaignId],
  );

  const handleTrackPost = async (payload: CreateSocialPostRequest): Promise<void> => {
    if (!campaignId) return;
    setPostBusy(true);
    setPostError(null);
    try {
      const post = await createSocialPost(apiFetch, campaignId, payload);
      setBundle((prev) =>
        prev ? { ...prev, social_posts: [...prev.social_posts, post] } : prev,
      );
      setShowPostForm(false);
    } catch (err) {
      setPostError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setPostBusy(false);
    }
  };

  const handleDeletePost = async (postId: string): Promise<void> => {
    if (!campaignId) return;
    setPostError(null);
    try {
      await deleteSocialPost(apiFetch, campaignId, postId);
      setBundle((prev) =>
        prev
          ? { ...prev, social_posts: prev.social_posts.filter((p) => p.post_id !== postId) }
          : prev,
      );
    } catch (err) {
      setPostError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  const handleTrackContentPost = async (payload: CreateContentPostRequest): Promise<void> => {
    if (!campaignId) return;
    setContentBusy(true);
    setContentError(null);
    try {
      const post = await createContentPost(apiFetch, campaignId, payload);
      setBundle((prev) =>
        prev ? { ...prev, content_posts: [...prev.content_posts, post] } : prev,
      );
      setShowContentForm(false);
    } catch (err) {
      setContentError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setContentBusy(false);
    }
  };

  const handleDeleteContentPost = async (postId: string): Promise<void> => {
    if (!campaignId) return;
    setContentError(null);
    try {
      await deleteContentPost(apiFetch, campaignId, postId);
      setBundle((prev) =>
        prev
          ? { ...prev, content_posts: prev.content_posts.filter((p) => p.post_id !== postId) }
          : prev,
      );
    } catch (err) {
      setContentError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  if (loadError) {
    return (
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">Campaign not found</h1>
        <p className="form-error">{loadError}</p>
        <Link to="/campaigns" className="btn-link">
          Back to campaigns
        </Link>
      </section>
    );
  }

  if (!bundle) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Campaign</h1>
        <p className="text-muted-foreground">Loading...</p>
      </section>
    );
  }

  const { campaign, links, social_posts: socialPosts, content_posts: contentPosts } = bundle;

  const onCampaignChange = (updated: Campaign): void =>
    setBundle((prev) => (prev ? { ...prev, campaign: updated } : prev));

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-2 flex-1 min-w-0">
          <div>
            <NameEditor
              apiFetch={apiFetch}
              campaign={campaign}
              onCampaignChange={onCampaignChange}
            />
          </div>
          <div>
            <VendorEditor
              apiFetch={apiFetch}
              campaign={campaign}
              onCampaignChange={onCampaignChange}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to={`/campaigns/${campaign.campaign_id}/report`}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary"
          >
            Sponsor report
          </Link>
          <StatusChipEditor
            apiFetch={apiFetch}
            campaign={campaign}
            onCampaignChange={onCampaignChange}
          />
        </div>
      </header>

      <nav className="border-b border-border flex gap-1" aria-label="Campaign sections">
        <TabButton
          label="Overview"
          active={activeTab === 'overview'}
          onClick={() => setActiveTab('overview')}
        />
        <TabButton
          label="Brief"
          active={activeTab === 'brief'}
          onClick={() => setActiveTab('brief')}
        />
        <TabButton
          label="Draft"
          active={activeTab === 'draft'}
          onClick={() => setActiveTab('draft')}
        />
        <TabButton
          label="Promotion"
          active={activeTab === 'promotion'}
          onClick={() => setActiveTab('promotion')}
        />
        <TabButton
          label="Analytics"
          active={activeTab === 'analytics'}
          onClick={() => setActiveTab('analytics')}
        />
      </nav>

      {activeTab === 'overview' && (
        <div className="space-y-8">
          <ExecutiveSummary
            campaign={campaign}
            analytics={analytics}
            webAnalytics={webAnalytics}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
            <FieldGroup label="Dates">
              <DateRangeField
                apiFetch={apiFetch}
                campaign={campaign}
                onCampaignChange={onCampaignChange}
              />
            </FieldGroup>
            <FieldGroup label="Payout">
              <PayoutField
                apiFetch={apiFetch}
                campaign={campaign}
                onCampaignChange={onCampaignChange}
              />
            </FieldGroup>
            <FieldGroup label="Deliverable" className="md:col-span-2">
              <BlogUrlField
                apiFetch={apiFetch}
                campaign={campaign}
                onCampaignChange={onCampaignChange}
              />
            </FieldGroup>
            <FieldGroup
              label="Link tracking ID"
              hint="Tags every short link minted for this campaign so analytics can roll up by campaign. Links minted before this is set won't be retroactively tagged."
              className="md:col-span-2"
            >
              <LinkTrackingIdField
                apiFetch={apiFetch}
                campaign={campaign}
                onCampaignChange={onCampaignChange}
              />
            </FieldGroup>
          </div>
        </div>
      )}

      {activeTab === 'promotion' && (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">Deliverable</h2>
            <BlogUrlField
              apiFetch={apiFetch}
              campaign={campaign}
              onCampaignChange={onCampaignChange}
            />
          </section>

          <section className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-foreground">Social posts</h2>
                <p className="text-sm text-muted-foreground">
                  Engagement is captured automatically by the Booked browser extension when you
                  visit each post.{' '}
                  <span className="font-medium text-foreground">Last fetched</span> shows the most
                  recent capture.
                </p>
              </div>
              <div
                className="flex items-center gap-2 shrink-0"
                data-booked-slot="social-posts-actions"
              >
                <button
                  type="button"
                  className="btn-secondary py-1 px-2 text-sm"
                  onClick={() => setExtensionModalOpen(true)}
                >
                  Install extension
                </button>
                {!showPostForm && (
                  <button
                    type="button"
                    className="btn-secondary py-1 px-2 text-sm"
                    onClick={() => setShowPostForm(true)}
                    aria-label="Track a new social post"
                  >
                    + Add post
                  </button>
                )}
              </div>
            </div>
            {postError && <p className="form-error">{postError}</p>}
            {socialPosts.length === 0 ? (
              <p className="text-muted-foreground">
                No social posts tracked yet. Click + Add post to start tracking one.
              </p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>Post</th>
                    <th>Engagement</th>
                    <th>Last fetched</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {socialPosts.map((post) => (
                    <tr key={post.post_id}>
                      <td>{post.platform}</td>
                      <td>
                        <a
                          href={post.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary-600 hover:underline"
                        >
                          {truncate(post.url, 50)}
                        </a>
                        {post.notes && (
                          <span className="block text-xs text-muted-foreground">{post.notes}</span>
                        )}
                      </td>
                      <td className="text-muted-foreground">{formatMetrics(post.analytics)}</td>
                      <td className="text-muted-foreground">
                        {formatTimestamp(post.last_fetched)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-link text-error-600"
                          onClick={() => void handleDeletePost(post.post_id)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {showPostForm && (
              <RegisterSocialPostForm
                busy={postBusy}
                serverError={postError}
                onCancel={() => {
                  setShowPostForm(false);
                  setPostError(null);
                }}
                onSubmit={(p) => void handleTrackPost(p)}
              />
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-foreground">Content posts</h2>
                <p className="text-sm text-muted-foreground">
                  Cross-posts on Medium and dev.to. The Booked browser extension captures
                  engagement as you browse to each post or its stats page.
                </p>
              </div>
              <div
                className="flex items-center gap-2 shrink-0"
                data-booked-slot="content-posts-actions"
              >
                {!showContentForm && (
                  <button
                    type="button"
                    className="btn-secondary py-1 px-2 text-sm"
                    onClick={() => setShowContentForm(true)}
                    aria-label="Track a new content post"
                  >
                    + Add post
                  </button>
                )}
              </div>
            </div>
            {contentError && <p className="form-error">{contentError}</p>}
            {contentPosts.length === 0 ? (
              <p className="text-muted-foreground">
                No content posts tracked yet. Click + Add post to start tracking one.
              </p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>Post</th>
                    <th>Engagement</th>
                    <th>Last fetched</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {contentPosts.map((post) => (
                    <tr key={post.post_id}>
                      <td>{post.platform}</td>
                      <td>
                        <a
                          href={post.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary-600 hover:underline"
                        >
                          {truncate(post.url, 50)}
                        </a>
                        {post.notes && (
                          <span className="block text-xs text-muted-foreground">{post.notes}</span>
                        )}
                      </td>
                      <td className="text-muted-foreground">{formatMetrics(post.analytics)}</td>
                      <td className="text-muted-foreground">
                        {formatTimestamp(post.last_fetched)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn-link text-error-600"
                          onClick={() => void handleDeleteContentPost(post.post_id)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {showContentForm && (
              <RegisterContentPostForm
                busy={contentBusy}
                serverError={contentError}
                onCancel={() => {
                  setShowContentForm(false);
                  setContentError(null);
                }}
                onSubmit={(p) => void handleTrackContentPost(p)}
              />
            )}
          </section>
        </>
      )}

      {activeTab === 'brief' && (
        <CampaignBriefSection
          apiFetch={apiFetch}
          campaign={campaign}
          brief={bundle.brief}
          onBriefChange={(brief) => setBundle((prev) => (prev ? { ...prev, brief } : prev))}
          onCampaignChange={onCampaignChange}
          onLinkCreated={appendLinkAndRefresh}
        />
      )}

      {activeTab === 'analytics' && (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-foreground">Analytics</h2>
              <div className="flex items-center gap-3">
                {analyticsFetchedAt && (
                  <span className="text-xs text-muted-foreground">
                    Updated {analyticsFetchedAt.toLocaleTimeString()}
                  </span>
                )}
                <button
                  type="button"
                  className="btn-secondary py-1 px-2 text-sm"
                  onClick={() => void refreshAnalytics()}
                  disabled={analyticsRefreshing}
                >
                  {analyticsRefreshing ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
            </div>
            {analyticsError && (
              <p className="form-error">Could not load analytics: {analyticsError}</p>
            )}
            {!analytics && !analyticsError && (
              <p className="text-muted-foreground">Loading analytics...</p>
            )}
            {analytics && (
              <>
                <AnalyticsDiagnostic
                  campaign={campaign}
                  localLinkCount={links.length}
                  analytics={analytics}
                />
                {analytics.upstream_failures > 0 && (
                  <p className="rounded-md border border-warning-200 bg-warning-50 text-warning-900 text-sm px-3 py-2">
                    {analytics.upstream_failures} of {analytics.link_count} link analytics calls
                    failed. Totals below exclude those.
                  </p>
                )}
                <ClickSummaryTiles analytics={analytics} />

                <h3 className="text-sm font-medium text-foreground mt-2">Clicks per day</h3>
                <ClicksChart byDay={analytics.by_day} />

                <ClickBreakdowns analytics={analytics} />

                <ClickLinkTable analytics={analytics} />
              </>
            )}
          </section>

          {campaignId && (
            <SocialEngagementSection
              apiFetch={apiFetch}
              campaignId={campaignId}
              posts={socialPosts}
            />
          )}

          {campaignId && (
            <ContentEngagementSection
              apiFetch={apiFetch}
              campaignId={campaignId}
              posts={contentPosts}
            />
          )}

          <WebAnalyticsSection
            blogUrl={campaign.blog_url}
            data={webAnalytics}
            loading={webAnalyticsLoading}
            error={webAnalyticsError}
          />
        </>
      )}

      {activeTab === 'draft' && (
        <CampaignDraftTab
          apiFetch={apiFetch}
          campaign={campaign}
          brief={bundle.brief}
          draft={bundle.draft}
          onDraftChange={(draft) => setBundle((prev) => (prev ? { ...prev, draft } : prev))}
        />
      )}

      <InstallExtensionModal
        open={extensionModalOpen}
        onClose={() => setExtensionModalOpen(false)}
      />
    </section>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-primary-600 text-primary-700'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
      }`}
    >
      {label}
    </button>
  );
}

function formatMetrics(analytics: Record<string, number> | null): string {
  if (!analytics) return '—';
  const entries = Object.entries(analytics);
  if (entries.length === 0) return '—';
  return entries.map(([key, value]) => `${key}: ${value.toLocaleString()}`).join(' · ');
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

// Surfaces which analytics path the server took and flags the common
// "minted before the campaign got tagged" trap: setting link_tracking_id
// on a campaign whose links were already minted means newsletter-service
// returns nothing for that tag, even if the per-code clicks are real.
function AnalyticsDiagnostic({
  campaign,
  localLinkCount,
  analytics,
}: {
  campaign: Campaign;
  localLinkCount: number;
  analytics: CampaignAnalyticsResponse;
}): ReactElement | null {
  const hasTrackingId = Boolean(campaign.link_tracking_id);
  const mode = hasTrackingId ? 'rollup' : 'fan-out';
  const mintedBeforeTag =
    hasTrackingId && localLinkCount > 0 && analytics.link_count < localLinkCount;

  if (mintedBeforeTag) {
    return (
      <div className="rounded-md border border-warning-200 bg-warning-50 text-warning-900 text-sm px-3 py-2 space-y-1">
        <p>
          <strong>Heads up:</strong> {localLinkCount} link
          {localLinkCount === 1 ? '' : 's'} registered locally, but only{' '}
          {analytics.link_count} tagged with <code>{campaign.link_tracking_id}</code> upstream.
        </p>
        <p>
          Links minted before the campaign got a tracking ID aren't retagged. Re-register them, or
          clear the tracking ID to fall back to per-link click lookups.
        </p>
      </div>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Source: {mode} ({analytics.link_count} link{analytics.link_count === 1 ? '' : 's'})
    </p>
  );
}

function Tile({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel?: string | null;
}): ReactElement {
  return (
    <div className="card card-body !py-3">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-foreground mt-1 block">{value}</span>
      {sublabel && (
        <span className="text-xs text-muted-foreground mt-0.5 block truncate">{sublabel}</span>
      )}
    </div>
  );
}

function ClickSummaryTiles({
  analytics,
}: {
  analytics: CampaignAnalyticsResponse;
}): ReactElement {
  const first = pickEarliest(analytics.links.map((l) => l.first_click_at));
  const last = pickLatest(analytics.links.map((l) => l.last_click_at));
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <Tile label="Total clicks" value={analytics.total_clicks.toLocaleString()} />
      <Tile
        label="Links"
        value={String(analytics.link_count)}
        sublabel={
          analytics.upstream_failures > 0
            ? `${analytics.upstream_failures} failed upstream`
            : null
        }
      />
      <Tile
        label="First click"
        value={first ? formatRelative(first) : '—'}
        sublabel={first ? formatDate(first) : null}
      />
      <Tile
        label="Last click"
        value={last ? formatRelative(last) : '—'}
        sublabel={last ? formatDate(last) : null}
      />
    </div>
  );
}

function ClickBreakdowns({
  analytics,
}: {
  analytics: CampaignAnalyticsResponse;
}): ReactElement | null {
  if (Object.keys(analytics.by_src).length === 0) return null;
  return (
    <Breakdown
      title="By source"
      counts={analytics.by_src}
      total={analytics.total_clicks}
      emptyLabel="No tagged sources"
    />
  );
}

function Breakdown({
  title,
  counts,
  total,
  formatKey,
  emptyLabel = 'No data',
}: {
  title: string;
  counts: Record<string, number>;
  total: number;
  formatKey?: (key: string) => string;
  emptyLabel?: string;
}): ReactElement {
  const rows = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="card card-body !py-3 space-y-2">
      <h4 className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
        {title}
      </h4>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map(([key, n]) => {
            const pct = total > 0 ? n / total : 0;
            return (
              <li key={key} className="space-y-0.5">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-foreground truncate">
                    {formatKey ? formatKey(key) : key}
                  </span>
                  <span className="text-muted-foreground shrink-0">
                    {n.toLocaleString()}
                    <span className="ml-1 text-xs">({formatPercent(pct)})</span>
                  </span>
                </div>
                <div className="h-1.5 rounded bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary-600"
                    style={{ width: `${Math.max(2, Math.round(pct * 100))}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ClickLinkTable({
  analytics,
}: {
  analytics: CampaignAnalyticsResponse;
}): ReactElement | null {
  if (analytics.links.length === 0) return null;
  const rows = [...analytics.links].sort(
    (a, b) => (b.total_clicks ?? 0) - (a.total_clicks ?? 0),
  );
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-foreground mt-2">Per-link clicks</h3>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Destination</th>
              <th className="text-right">Clicks</th>
              <th>First clicked</th>
              <th>Last clicked</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.code}>
                <td>
                  {l.url ? (
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary-600 hover:underline"
                    >
                      {truncate(l.url, 60)}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="text-right tabular-nums">
                  {l.error ? (
                    <span className="text-error-600" title={l.error}>
                      error
                    </span>
                  ) : (
                    l.total_clicks.toLocaleString()
                  )}
                </td>
                <td className="text-muted-foreground" title={l.first_click_at ?? ''}>
                  {l.first_click_at ? formatDate(l.first_click_at) : '—'}
                </td>
                <td className="text-muted-foreground" title={l.last_click_at ?? ''}>
                  {l.last_click_at ? formatRelative(l.last_click_at) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function pickEarliest(values: (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (!best || v < best) best = v;
  }
  return best;
}

function pickLatest(values: (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (!best || v > best) best = v;
  }
  return best;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  let phrase: string;
  if (sec < 60) phrase = `${sec}s`;
  else if (min < 60) phrase = `${min}m`;
  else if (hr < 48) phrase = `${hr}h`;
  else if (day < 30) phrase = `${day}d`;
  else return d.toLocaleDateString();
  return future ? `in ${phrase}` : `${phrase} ago`;
}

function WebAnalyticsSection({
  blogUrl,
  data,
  loading,
  error,
}: {
  blogUrl: string | null;
  data: WebAnalyticsResponse | null;
  loading: boolean;
  error: string | null;
}): ReactElement {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">Web analytics</h2>
      {!blogUrl ? (
        <p className="text-sm text-muted-foreground">
          Set a blog post URL on this campaign to pull GA4 traffic and Core Web Vitals.
        </p>
      ) : (
        <>
          {error && <p className="form-error">Could not load web analytics: {error}</p>}
          {loading && !data && <p className="text-muted-foreground">Loading web analytics...</p>}
          {data && (
            <>
              <Ga4Block ga4={data.ga4} />
              <CoreWebVitalsBlock cwv={data.core_web_vitals} />
            </>
          )}
        </>
      )}
    </section>
  );
}

function Ga4Block({ ga4 }: { ga4: Ga4Section }): ReactElement {
  if (!ga4.configured) {
    return <NotConnected label="Google Analytics 4" />;
  }
  if (ga4.error || !ga4.totals) {
    return (
      <div className="card card-body">
        <h3 className="text-sm font-semibold text-foreground mb-1">Google Analytics 4</h3>
        <p className="form-error">{ga4.error ?? 'No data returned.'}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">Google Analytics 4</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Pageviews" value={ga4.totals.pageviews.toLocaleString()} />
        <Tile label="Users" value={ga4.totals.users.toLocaleString()} />
        <Tile label="Sessions" value={ga4.totals.sessions.toLocaleString()} />
        <Tile label="Engagement" value={formatPercent(ga4.totals.engagement_rate)} />
        <Tile label="Avg. session" value={formatDuration(ga4.totals.avg_session_duration)} />
        <Tile label="Bounce rate" value={formatPercent(ga4.totals.bounce_rate)} />
      </div>
      {ga4.by_day && Object.keys(ga4.by_day).length > 0 && (
        <>
          <h4 className="text-sm font-medium text-foreground mt-2">Pageviews per day</h4>
          <ClicksChart byDay={ga4.by_day} />
        </>
      )}
    </div>
  );
}

function CoreWebVitalsBlock({ cwv }: { cwv: CoreWebVitalsSection }): ReactElement {
  if (!cwv.configured) {
    return <NotConnected label="Core Web Vitals" />;
  }
  if (cwv.error || !cwv.metrics) {
    return (
      <div className="card card-body">
        <h3 className="text-sm font-semibold text-foreground mb-1">Core Web Vitals</h3>
        <p className="form-error">{cwv.error ?? 'No data returned.'}</p>
      </div>
    );
  }
  const sourceLabel =
    cwv.source === 'crux' ? 'real-user field data (CrUX)' : 'lab estimate (PageSpeed Insights)';
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">Core Web Vitals</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="LCP" value={formatMs(cwv.metrics.lcp_ms)} />
        <Tile label="CLS" value={formatCls(cwv.metrics.cls)} />
        <Tile label="INP" value={formatMs(cwv.metrics.inp_ms)} />
        <Tile label="FCP" value={formatMs(cwv.metrics.fcp_ms)} />
      </div>
      <p className="text-xs text-muted-foreground">
        Source: {sourceLabel}
        {typeof cwv.performance_score === 'number' &&
          ` · Performance score ${Math.round(cwv.performance_score * 100)}`}
      </p>
    </div>
  );
}

function NotConnected({ label }: { label: string }): ReactElement {
  return (
    <div className="card card-body">
      <h3 className="text-sm font-semibold text-foreground mb-1">{label}</h3>
      <p className="text-sm text-muted-foreground">
        Not connected.{' '}
        <Link to="/settings" className="text-primary-600 hover:underline">
          Connect it in Settings
        </Link>
        .
      </p>
    </div>
  );
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function formatCls(cls: number | null | undefined): string {
  return cls === null || cls === undefined ? '—' : cls.toFixed(3);
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '0s';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

interface EditScaffoldProps {
  editing: boolean;
  busy: boolean;
  error: string | null;
  hasValue: boolean;
  display: ReactElement;
  form: ReactElement;
  onStart: () => void;
  onCancel: () => void;
  onSave: () => void;
  emptyLabel?: string;
}

function EditScaffold({
  editing,
  busy,
  error,
  hasValue,
  display,
  form,
  onStart,
  onCancel,
  onSave,
  emptyLabel = 'Not set',
}: EditScaffoldProps): ReactElement {
  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2 flex-wrap">
        {hasValue ? display : <span className="text-muted-foreground italic">{emptyLabel}</span>}
        <EditIconButton onClick={onStart} label={hasValue ? 'Edit' : 'Add'} />
      </span>
    );
  }
  return (
    <div className="space-y-2">
      {form}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-primary py-1 text-sm"
          onClick={onSave}
          disabled={busy}
        >
          {busy ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          className="btn-secondary py-1 text-sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

interface FieldEditorProps {
  apiFetch: ApiFetch;
  campaign: Campaign;
  onCampaignChange: (campaign: Campaign) => void;
}

function NameEditor({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(campaign.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (): void => {
    setValue(campaign.name);
    setError(null);
    setEditing(true);
  };
  const cancel = (): void => {
    setEditing(false);
    setError(null);
  };
  const save = async (): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setError('Name is required.');
      return;
    }
    if (trimmed === campaign.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, { name: trimmed });
      onCampaignChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditScaffold
      editing={editing}
      busy={busy}
      error={error}
      hasValue
      onStart={start}
      onCancel={cancel}
      onSave={() => void save()}
      display={<h1 className="text-2xl font-semibold text-foreground">{campaign.name}</h1>}
      form={
        <input
          type="text"
          className="input text-lg"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') cancel();
          }}
        />
      }
    />
  );
}

// Links the campaign to a vendor record. Picking from the dropdown saves
// immediately; "+ Create new vendor…" opens an inline modal and links the
// freshly created vendor on save. Campaigns predating a vendor record may
// still carry a free-text `sponsor` — we show it until a vendor is linked.
function VendorEditor({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const save = async (vendorId: string): Promise<void> => {
    if (!vendorId || vendorId === campaign.vendor_id) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, {
        vendor_id: vendorId,
      });
      onCampaignChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (payload: VendorPayload): Promise<void> => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const vendor = await createVendor(apiFetch, payload);
      setRefreshSignal((n) => n + 1);
      setModalOpen(false);
      await save(vendor.vendor_id);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setCreateBusy(false);
    }
  };

  const hasVendor = Boolean(campaign.vendor_id);

  return (
    <>
      {!editing ? (
        <span className="inline-flex items-center gap-2 flex-wrap">
          {hasVendor ? (
            <Link
              to={`/vendors/${campaign.vendor_id}`}
              className="text-primary-600 hover:underline"
            >
              {campaign.sponsor ?? campaign.vendor_id}
            </Link>
          ) : campaign.sponsor ? (
            <span className="text-muted-foreground">{campaign.sponsor}</span>
          ) : (
            <span className="text-muted-foreground italic">No vendor</span>
          )}
          <EditIconButton
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
            label={hasVendor ? 'Change vendor' : campaign.sponsor ? 'Link vendor' : 'Add vendor'}
          />
        </span>
      ) : (
        <div className="space-y-2 max-w-sm">
          <VendorSelect
            value={campaign.vendor_id ?? ''}
            onChange={(id) => void save(id)}
            onCreateNew={() => setModalOpen(true)}
            disabled={busy}
            refreshSignal={refreshSignal}
            autoFocus
            ariaLabel="Select vendor"
          />
          <div className="flex items-center gap-2">
            {busy && <span className="text-xs text-muted-foreground">Saving…</span>}
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}
        </div>
      )}

      <Modal
        open={modalOpen}
        title="Create vendor"
        onClose={() => {
          if (!createBusy) {
            setModalOpen(false);
            setCreateError(null);
          }
        }}
      >
        <VendorForm
          busy={createBusy}
          serverError={createError}
          submitLabel="Create vendor"
          onSubmit={(p) => void handleCreate(p)}
          onCancel={() => {
            setModalOpen(false);
            setCreateError(null);
          }}
        />
      </Modal>
    </>
  );
}

interface AutoSaveState {
  saving: boolean;
  saved: boolean;
  error: string | null;
}

function useAutoSave(): {
  state: AutoSaveState;
  run: (action: () => Promise<void>) => Promise<void>;
  setError: (message: string | null) => void;
} {
  const [state, setState] = useState<AutoSaveState>({ saving: false, saved: false, error: null });

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setState({ saving: true, saved: false, error: null });
    try {
      await action();
      setState({ saving: false, saved: true, error: null });
      setTimeout(() => {
        setState((prev) => (prev.saved ? { ...prev, saved: false } : prev));
      }, 1500);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      setState({ saving: false, saved: false, error: message });
    }
  }, []);

  const setError = useCallback((message: string | null): void => {
    setState({ saving: false, saved: false, error: message });
  }, []);

  return { state, run, setError };
}

function SaveIndicator({ state }: { state: AutoSaveState }): ReactElement | null {
  if (state.saving) {
    return <span className="text-xs text-muted-foreground shrink-0">Saving…</span>;
  }
  if (state.saved) {
    return <span className="text-xs text-success-700 shrink-0">Saved</span>;
  }
  if (state.error) {
    return <span className="text-xs text-error-600 shrink-0">{state.error}</span>;
  }
  return null;
}

function StatusChipEditor({
  apiFetch,
  campaign,
  onCampaignChange,
}: FieldEditorProps): ReactElement {
  const { state, run } = useAutoSave();

  const handleChange = (next: CampaignStatus): void => {
    if (next === campaign.status) return;
    void run(async () => {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, { status: next });
      onCampaignChange(updated);
    });
  };

  return (
    <div className="inline-flex items-center gap-2">
      <span
        className={`relative inline-flex items-center gap-1 status-pill status-${campaign.status} cursor-pointer hover:opacity-80 focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-1 ${
          state.saving ? 'opacity-60' : ''
        }`}
      >
        <span>{campaign.status}</span>
        <ChevronDownIcon />
        <select
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          value={campaign.status}
          onChange={(e) => handleChange(e.target.value as CampaignStatus)}
          disabled={state.saving}
          aria-label="Change campaign status"
        >
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="monitoring">monitoring</option>
          <option value="completed">completed</option>
        </select>
      </span>
      <SaveIndicator state={state} />
    </div>
  );
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-3 h-3 opacity-60"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function DateRangeField({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [start, setStart] = useState(campaign.startDate ?? '');
  const [end, setEnd] = useState(campaign.endDate ?? '');
  const { state, run, setError } = useAutoSave();

  useEffect(() => {
    setStart(campaign.startDate ?? '');
    setEnd(campaign.endDate ?? '');
  }, [campaign.startDate, campaign.endDate]);

  const commit = (nextStart: string, nextEnd: string): void => {
    const sameStart = nextStart === (campaign.startDate ?? '');
    const sameEnd = nextEnd === (campaign.endDate ?? '');
    if (sameStart && sameEnd) return;
    if (nextStart && nextEnd && nextEnd < nextStart) {
      setError('End date must be on or after start date.');
      return;
    }
    const payload: { startDate?: string; endDate?: string } = {};
    if (nextStart) payload.startDate = nextStart;
    if (nextEnd) payload.endDate = nextEnd;
    void run(async () => {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, payload);
      onCampaignChange(updated);
    });
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-2">
        <input
          type="date"
          className="input py-1.5 text-sm w-auto"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          onBlur={() => commit(start, end)}
          disabled={state.saving}
          aria-label="Start date"
        />
        <span className="text-muted-foreground">→</span>
        <input
          type="date"
          className="input py-1.5 text-sm w-auto"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          onBlur={() => commit(start, end)}
          disabled={state.saving}
          aria-label="End date"
        />
      </div>
      <SaveIndicator state={state} />
    </div>
  );
}

function PayoutField({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [amount, setAmount] = useState(
    campaign.payout?.amount !== undefined ? String(campaign.payout.amount) : '',
  );
  const [currency, setCurrency] = useState(campaign.payout?.currency ?? 'USD');
  const paid = campaign.payout?.paid ?? false;
  const { state, run, setError } = useAutoSave();

  useEffect(() => {
    setAmount(campaign.payout?.amount !== undefined ? String(campaign.payout.amount) : '');
    setCurrency(campaign.payout?.currency ?? 'USD');
  }, [campaign.payout?.amount, campaign.payout?.currency]);

  const commit = (nextAmount: string, nextCurrency: string, nextPaid: boolean): void => {
    const trimmedAmount = nextAmount.trim();
    const trimmedCurrency = nextCurrency.toUpperCase().trim();
    const same =
      trimmedAmount === (campaign.payout?.amount !== undefined ? String(campaign.payout.amount) : '') &&
      trimmedCurrency === (campaign.payout?.currency ?? 'USD') &&
      nextPaid === paid;
    if (same) return;
    if (trimmedAmount.length === 0) {
      // No amount yet — don't save partial payout. Silent: it's just empty.
      return;
    }
    const num = Number(trimmedAmount);
    if (!Number.isFinite(num) || num < 0) {
      setError('Amount must be a non-negative number.');
      return;
    }
    if (!/^[A-Z]{3}$/.test(trimmedCurrency)) {
      setError('Currency must be a 3-letter ISO 4217 code (e.g., USD).');
      return;
    }
    void run(async () => {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, {
        payout: { amount: num, currency: trimmedCurrency, paid: nextPaid },
      });
      onCampaignChange(updated);
    });
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          step="0.01"
          className="input py-1.5 text-sm w-32"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => commit(amount, currency, paid)}
          placeholder="Amount"
          disabled={state.saving}
          aria-label="Payout amount"
        />
        <input
          type="text"
          maxLength={3}
          className="input py-1.5 text-sm uppercase w-20"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          onBlur={() => commit(amount, currency, paid)}
          placeholder="USD"
          disabled={state.saving}
          aria-label="Payout currency"
        />
        <label className="inline-flex items-center gap-2 text-sm select-none">
          <input
            type="checkbox"
            className="rounded border-border text-primary-600 focus:ring-primary-500"
            checked={paid}
            onChange={(e) => commit(amount, currency, e.target.checked)}
            disabled={state.saving}
          />
          Paid
        </label>
      </div>
      <SaveIndicator state={state} />
    </div>
  );
}

function BlogUrlField({ apiFetch, campaign, onCampaignChange }: FieldEditorProps): ReactElement {
  const [value, setValue] = useState(campaign.blog_url ?? '');
  const { state, run, setError } = useAutoSave();

  useEffect(() => {
    setValue(campaign.blog_url ?? '');
  }, [campaign.blog_url]);

  const commit = (): void => {
    const trimmed = value.trim();
    if (trimmed === (campaign.blog_url ?? '')) return;
    if (trimmed.length === 0) {
      // Don't fire an update; clearing isn't supported by the API.
      setValue(campaign.blog_url ?? '');
      return;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
      setError('URL must start with http:// or https://');
      return;
    }
    void run(async () => {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, { blog_url: trimmed });
      onCampaignChange(updated);
    });
  };

  return (
    <div className="flex items-center gap-3">
      <input
        type="url"
        className="input py-1.5 text-sm flex-1 min-w-0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setValue(campaign.blog_url ?? '');
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder="https://blog.example.com/my-post"
        disabled={state.saving}
      />
      <SaveIndicator state={state} />
    </div>
  );
}

function LinkTrackingIdField({
  apiFetch,
  campaign,
  onCampaignChange,
}: FieldEditorProps): ReactElement {
  const [value, setValue] = useState(campaign.link_tracking_id ?? '');
  const { state, run } = useAutoSave();

  useEffect(() => {
    setValue(campaign.link_tracking_id ?? '');
  }, [campaign.link_tracking_id]);

  const commit = (): void => {
    const trimmed = value.trim();
    if (trimmed === (campaign.link_tracking_id ?? '')) return;
    if (trimmed.length === 0) {
      // Clearing isn't supported by the API; revert.
      setValue(campaign.link_tracking_id ?? '');
      return;
    }
    void run(async () => {
      const updated = await updateCampaign(apiFetch, campaign.campaign_id, {
        link_tracking_id: trimmed,
      });
      onCampaignChange(updated);
    });
  };

  return (
    <div className="flex items-center gap-3">
      <input
        type="text"
        className="input py-1.5 text-sm font-mono w-64 max-w-full"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setValue(campaign.link_tracking_id ?? '');
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder="acme-q2-launch"
        disabled={state.saving}
      />
      <SaveIndicator state={state} />
    </div>
  );
}

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate && !endDate) return '-';
  if (startDate && endDate) return `${startDate} → ${endDate}`;
  return startDate ?? endDate ?? '-';
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function EditIconButton({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:text-primary-600 hover:bg-muted transition-colors disabled:opacity-50"
    >
      <PencilIcon />
    </button>
  );
}

function PencilIcon({ className = 'w-3.5 h-3.5' }: { className?: string }): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.379-8.379-2.828-2.828z" />
    </svg>
  );
}

function FieldGroup({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactElement;
}): ReactElement {
  return (
    <div className={`space-y-2 ${className ?? ''}`}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</p>
      <div className="text-sm text-foreground">{children}</div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ExecutiveSummary({
  campaign,
  analytics,
  webAnalytics,
}: {
  campaign: Campaign;
  analytics: CampaignAnalyticsResponse | null;
  webAnalytics: WebAnalyticsResponse | null;
}): ReactElement {
  const timeline = computeTimeline(campaign);
  const totalClicks = analytics?.total_clicks ?? null;
  const clicksByDay = analytics?.by_day ?? null;
  const pageviews = webAnalytics?.ga4?.totals?.pageviews ?? null;
  const ga4Configured = webAnalytics?.ga4?.configured ?? false;

  let pageviewsSub: string;
  if (!campaign.blog_url) pageviewsSub = 'No blog URL';
  else if (!ga4Configured) pageviewsSub = 'GA4 not connected';
  else pageviewsSub = 'GA4';

  return (
    <section
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
      aria-label="Campaign summary"
    >
      <SummaryTile label="Timeline" value={timeline.primary} sublabel={timeline.secondary} />
      <SummaryTile
        label="Clicks"
        value={totalClicks !== null ? totalClicks.toLocaleString() : '—'}
        sublabel={
          totalClicks === null
            ? 'Loading…'
            : `${analytics?.link_count ?? 0} link${analytics?.link_count === 1 ? '' : 's'}`
        }
        sparkline={clicksByDay && totalClicks ? <Sparkline byDay={clicksByDay} /> : null}
      />
      <SummaryTile
        label="Pageviews"
        value={pageviews !== null ? pageviews.toLocaleString() : '—'}
        sublabel={pageviewsSub}
      />
      <SummaryTile
        label="Payout"
        value={formatPayoutShort(campaign.payout)}
        sublabel={campaign.payout ? null : 'No payout set'}
        pill={
          campaign.payout ? (
            <span
              className={`status-pill ${
                campaign.payout.paid
                  ? 'bg-success-100 text-success-800'
                  : 'bg-warning-100 text-warning-800'
              }`}
            >
              {campaign.payout.paid ? 'Paid' : 'Unpaid'}
            </span>
          ) : null
        }
      />
    </section>
  );
}

function SummaryTile({
  label,
  value,
  sublabel,
  pill,
  sparkline,
}: {
  label: string;
  value: string;
  sublabel?: string | null;
  pill?: ReactElement | null;
  sparkline?: ReactElement | null;
}): ReactElement {
  return (
    <div className="card card-body !px-4 !py-3 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
          {label}
        </span>
        {pill}
      </div>
      <div className="flex items-end justify-between gap-3">
        <span className="text-2xl font-semibold text-foreground leading-none">{value}</span>
        {sparkline && <div className="w-24 h-8 shrink-0">{sparkline}</div>}
      </div>
      {sublabel && <span className="text-xs text-muted-foreground truncate">{sublabel}</span>}
    </div>
  );
}

function Sparkline({ byDay }: { byDay: Record<string, number> }): ReactElement | null {
  const data = useMemo(() => {
    const entries = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) return [];
    if (entries.length === 1) return entries.map(([date, clicks]) => ({ date, clicks }));
    const first = new Date(entries[0][0] + 'T00:00:00Z');
    const last = new Date(entries[entries.length - 1][0] + 'T00:00:00Z');
    const map = new Map(entries);
    const dense: { date: string; clicks: number }[] = [];
    for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      dense.push({ date: iso, clicks: map.get(iso) ?? 0 });
    }
    return dense;
  }, [byDay]);

  if (data.length < 2) return null;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Line
          type="monotone"
          dataKey="clicks"
          stroke="rgb(var(--primary-600))"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function computeTimeline(campaign: Campaign): { primary: string; secondary: string | null } {
  const { startDate, endDate, status } = campaign;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = startDate ? new Date(startDate + 'T00:00:00') : null;
  const end = endDate ? new Date(endDate + 'T00:00:00') : null;
  const range = formatDateRange(startDate, endDate);
  const dayMs = 86_400_000;

  if (status === 'completed') {
    return { primary: 'Completed', secondary: range !== '-' ? range : null };
  }

  if (start && end) {
    if (today < start) {
      const days = Math.ceil((start.getTime() - today.getTime()) / dayMs);
      return { primary: `Starts in ${days}d`, secondary: range };
    }
    if (today > end) {
      const days = Math.ceil((today.getTime() - end.getTime()) / dayMs);
      return { primary: `Ended ${days}d ago`, secondary: range };
    }
    const days = Math.ceil((end.getTime() - today.getTime()) / dayMs);
    return { primary: `${days}d left`, secondary: range };
  }

  if (start) {
    if (today < start) {
      const days = Math.ceil((start.getTime() - today.getTime()) / dayMs);
      return { primary: `Starts in ${days}d`, secondary: `From ${startDate}` };
    }
    const days = Math.ceil((today.getTime() - start.getTime()) / dayMs) + 1;
    return { primary: `Day ${days}`, secondary: `From ${startDate}` };
  }

  if (end) {
    if (today > end) {
      const days = Math.ceil((today.getTime() - end.getTime()) / dayMs);
      return { primary: `Ended ${days}d ago`, secondary: `Until ${endDate}` };
    }
    const days = Math.ceil((end.getTime() - today.getTime()) / dayMs);
    return { primary: `${days}d left`, secondary: `Until ${endDate}` };
  }

  return { primary: 'Not scheduled', secondary: null };
}

function formatPayoutShort(payout: Campaign['payout']): string {
  if (!payout) return '—';
  const amount = payout.amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${amount} ${payout.currency}`;
}
