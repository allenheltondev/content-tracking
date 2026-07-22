import type { ReactElement } from 'react';
import { useCallback, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch, ApiError } from '../auth/useApiFetch';
import {
  createContentPost,
  createSocialPost,
  deleteContentPost,
  deleteSocialPost,
  getCampaign,
  getCampaignAnalytics,
  getCampaignWebAnalytics,
} from '../api/campaigns';
import type {
  Campaign,
  CampaignDetailResponse,
  CampaignLink,
  CreateContentPostRequest,
  CreateSocialPostRequest,
  DeliverableType,
} from '../api/types';
import ClicksChart from '../components/ClicksChart';
import RegisterSocialPostForm from '../components/RegisterSocialPostForm';
import RegisterContentPostForm from '../components/RegisterContentPostForm';
import CampaignBriefSection from '../components/CampaignBriefSection';
import CampaignDraftTab from '../components/CampaignDraftTab';
import CampaignReportsTab from '../components/CampaignReportsTab';
import EngagementSection from '../components/EngagementSection';
import EngagementRecommendationsSection from '../components/EngagementRecommendationsSection';
import InstallExtensionModal from '../components/InstallExtensionModal';
import { AnalyticsDiagnostic, ClickBreakdowns, ClickLinkTable, ClickSummaryTiles } from './campaign-detail/ClickAnalytics';
import { WebAnalyticsSection } from './campaign-detail/WebAnalytics';
import {
  DateRangeField,
  DeliverableField,
  FieldGroup,
  LinkTrackingIdField,
  NameEditor,
  PayoutField,
  StatusChipEditor,
  VendorEditor,
} from './campaign-detail/editors';
import { ExecutiveSummary } from './campaign-detail/ExecutiveSummary';
import { truncate } from '../lib/format';

type CampaignTab = 'overview' | 'brief' | 'draft' | 'promotion' | 'analytics' | 'reports';

const CAMPAIGN_TABS: readonly CampaignTab[] = [
  'overview',
  'brief',
  'draft',
  'promotion',
  'analytics',
  'reports',
];

const TAB_LABELS: Record<CampaignTab, string> = {
  overview: 'Overview',
  brief: 'Brief',
  draft: 'Draft',
  promotion: 'Promotion',
  analytics: 'Analytics',
  reports: 'Reports',
};

// Renders the campaign workspace (header editors + Overview/Brief/Draft/
// Promotion/Analytics/Reports tabs). Normally a route keyed off the URL's
// :campaignId, but it also accepts an explicit `campaignId` prop so the
// content detail page can embed the same workspace inline for the sponsorship
// that hangs off a piece of content — no duplicated orchestration.
export default function CampaignDetail({ campaignId: campaignIdProp }: { campaignId?: string } = {}): ReactElement {
  const routeParams = useParams<{ campaignId: string }>();
  const campaignId = campaignIdProp ?? routeParams.campaignId;
  const [searchParams, setSearchParams] = useSearchParams();
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();

  // The active tab is driven by ?tab= so a tab is deep-linkable and shareable
  // and survives reloads / back-forward. Unknown or missing values fall back
  // to overview. Switching tabs rewrites the param in place (replace, so tab
  // clicks don't pile up history entries).
  const tabParam = searchParams.get('tab');
  const activeTab: CampaignTab = CAMPAIGN_TABS.includes(tabParam as CampaignTab)
    ? (tabParam as CampaignTab)
    : 'overview';
  const selectTab = useCallback(
    (tab: CampaignTab): void => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('tab', tab);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const [postBusy, setPostBusy] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const [showPostForm, setShowPostForm] = useState(false);

  const [contentBusy, setContentBusy] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [showContentForm, setShowContentForm] = useState(false);

  const [extensionModalOpen, setExtensionModalOpen] = useState(false);

  // Campaign metadata + links. Cheap; fires on mount.
  const bundleQuery = useQuery({
    queryKey: ['campaign', campaignId],
    queryFn: () => getCampaign(apiFetch, campaignId as string),
    enabled: Boolean(campaignId),
  });
  const bundle = bundleQuery.data ?? null;
  const loadError = bundleQuery.error ? (bundleQuery.error as Error).message : null;

  // Analytics. Whether the server takes the per-link fan-out path or the
  // one-shot newsletter-service campaignId rollup depends on the campaign's
  // link_tracking_id, so onCampaignChange below invalidates this query
  // whenever that value changes (e.g., the user just added one via the
  // inline editor).
  const analyticsQuery = useQuery({
    queryKey: ['campaign', campaignId, 'analytics'],
    queryFn: () => getCampaignAnalytics(apiFetch, campaignId as string),
    enabled: Boolean(campaignId) && bundle !== null,
  });
  const analytics = analyticsQuery.data ?? null;
  const analyticsError = analyticsQuery.error ? (analyticsQuery.error as Error).message : null;
  const analyticsFetchedAt =
    analyticsQuery.dataUpdatedAt > 0 ? new Date(analyticsQuery.dataUpdatedAt) : null;
  const analyticsRefreshing = analyticsQuery.isRefetching;

  // Web analytics only make sense once the campaign's main-deliverable URL is
  // set — GA4 + Core Web Vitals off blog_url for a blog, YouTube Data API off
  // youtube_url for a video. The call is slow (it hits Google), so it runs on
  // its own after the campaign loads and only when the relevant URL is set.
  const deliverableType: DeliverableType = bundle?.campaign.deliverable_type ?? 'blog';
  const analyticsUrl =
    deliverableType === 'youtube'
      ? bundle?.campaign.youtube_url ?? null
      : bundle?.campaign.blog_url ?? null;
  const webAnalyticsQuery = useQuery({
    queryKey: ['campaign', campaignId, 'web-analytics'],
    queryFn: () => getCampaignWebAnalytics(apiFetch, campaignId as string),
    enabled: Boolean(campaignId) && Boolean(analyticsUrl),
  });
  const webAnalytics = analyticsUrl ? webAnalyticsQuery.data ?? null : null;
  const webAnalyticsError =
    analyticsUrl && webAnalyticsQuery.error ? (webAnalyticsQuery.error as Error).message : null;
  const webAnalyticsLoading = Boolean(analyticsUrl) && webAnalyticsQuery.isFetching;

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
      if (!campaignId) return;
      queryClient.setQueryData<CampaignDetailResponse>(['campaign', campaignId], (prev) => {
        if (!prev) return prev;
        const next = { ...prev, links: [...prev.links, link] };
        if (
          link.role === 'main' &&
          !prev.campaign.blog_url &&
          (prev.campaign.deliverable_type ?? 'blog') !== 'youtube'
        ) {
          next.campaign = { ...prev.campaign, blog_url: link.url };
        }
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId, 'analytics'] });
    },
    [queryClient, campaignId],
  );

  const handleTrackPost = async (payload: CreateSocialPostRequest): Promise<void> => {
    if (!campaignId) return;
    setPostBusy(true);
    setPostError(null);
    try {
      const post = await createSocialPost(apiFetch, campaignId, payload);
      queryClient.setQueryData<CampaignDetailResponse>(['campaign', campaignId], (prev) =>
        prev ? { ...prev, social_posts: [...prev.social_posts, post] } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId], exact: true });
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
      queryClient.setQueryData<CampaignDetailResponse>(['campaign', campaignId], (prev) =>
        prev
          ? { ...prev, social_posts: prev.social_posts.filter((p) => p.post_id !== postId) }
          : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId], exact: true });
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
      queryClient.setQueryData<CampaignDetailResponse>(['campaign', campaignId], (prev) =>
        prev ? { ...prev, content_posts: [...prev.content_posts, post] } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId], exact: true });
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
      queryClient.setQueryData<CampaignDetailResponse>(['campaign', campaignId], (prev) =>
        prev
          ? { ...prev, content_posts: prev.content_posts.filter((p) => p.post_id !== postId) }
          : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId], exact: true });
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

  const onCampaignChange = (updated: Campaign): void => {
    const previous = campaign;
    queryClient.setQueryData<CampaignDetailResponse>(['campaign', campaignId], (prev) =>
      prev ? { ...prev, campaign: updated } : prev,
    );
    // The analytics fetch path depends on link_tracking_id (see the analytics
    // query comment above), so refetch when it changes.
    if (previous.link_tracking_id !== updated.link_tracking_id) {
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId, 'analytics'] });
    }
    // Web analytics follow the main-deliverable URL; refetch when it changes.
    const previousUrl =
      (previous.deliverable_type ?? 'blog') === 'youtube'
        ? previous.youtube_url
        : previous.blog_url;
    const updatedUrl =
      (updated.deliverable_type ?? 'blog') === 'youtube' ? updated.youtube_url : updated.blog_url;
    if (previousUrl !== updatedUrl) {
      void queryClient.invalidateQueries({ queryKey: ['campaign', campaignId, 'web-analytics'] });
    }
  };

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
          <StatusChipEditor
            apiFetch={apiFetch}
            campaign={campaign}
            onCampaignChange={onCampaignChange}
          />
        </div>
      </header>

      {/* On phones the six tabs don't fit, so collapse them into a single
          native dropdown that shows every section at once. The tab row
          returns at md and up. */}
      <div className="md:hidden">
        <label className="sr-only" htmlFor="campaign-section">
          Campaign section
        </label>
        <select
          id="campaign-section"
          className="input"
          value={activeTab}
          onChange={(e) => selectTab(e.target.value as CampaignTab)}
        >
          {CAMPAIGN_TABS.map((tab) => (
            <option key={tab} value={tab}>
              {TAB_LABELS[tab]}
            </option>
          ))}
        </select>
      </div>

      <nav className="border-b border-border hidden md:flex gap-1" aria-label="Campaign sections">
        {CAMPAIGN_TABS.map((tab) => (
          <TabButton
            key={tab}
            label={TAB_LABELS[tab]}
            active={activeTab === tab}
            onClick={() => selectTab(tab)}
          />
        ))}
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
              <DeliverableField
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
            <DeliverableField
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
                  className="btn btn-secondary py-1 px-2 text-sm"
                  onClick={() => setExtensionModalOpen(true)}
                >
                  Install extension
                </button>
                {!showPostForm && (
                  <button
                    type="button"
                    className="btn btn-secondary py-1 px-2 text-sm"
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
              <div className="overflow-x-auto">
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
              </div>
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
                    className="btn btn-secondary py-1 px-2 text-sm"
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
              <div className="overflow-x-auto">
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
              </div>
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
          onBriefChange={(brief) => {
            queryClient.setQueryData<CampaignDetailResponse>(['campaign', campaignId], (prev) =>
              prev ? { ...prev, brief } : prev,
            );
          }}
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
                  className="btn btn-secondary py-1 px-2 text-sm"
                  onClick={() => void analyticsQuery.refetch()}
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
            <EngagementSection
              bucket="social"
              apiFetch={apiFetch}
              campaignId={campaignId}
              posts={socialPosts}
            />
          )}

          {campaignId && (
            <EngagementSection
              bucket="content"
              apiFetch={apiFetch}
              campaignId={campaignId}
              posts={contentPosts}
            />
          )}

          {campaignId && (
            <EngagementRecommendationsSection
              apiFetch={apiFetch}
              campaignId={campaignId}
              posts={contentPosts}
            />
          )}

          <WebAnalyticsSection
            campaign={campaign}
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
          onDraftChange={(draft) => {
            queryClient.setQueryData<CampaignDetailResponse>(['campaign', campaignId], (prev) =>
              prev ? { ...prev, draft } : prev,
            );
          }}
        />
      )}

      {activeTab === 'reports' && campaignId && (
        <CampaignReportsTab apiFetch={apiFetch} campaignId={campaignId} />
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
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap shrink-0 ${
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
