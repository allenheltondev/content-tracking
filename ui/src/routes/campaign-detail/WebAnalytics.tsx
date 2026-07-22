import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import type {
  Campaign,
  CoreWebVitalsSection,
  Ga4Section,
  WebAnalyticsResponse,
  YoutubeSection,
} from '../../api/types';
import ClicksChart from '../../components/ClicksChart';
import Tile from '../../components/Tile';
import { fmtPercentWhole } from '../../lib/format';

// Web analytics for the Analytics tab: the YouTube / GA4 / Core Web
// Vitals blocks behind GET /campaigns/:id/web-analytics.

export function WebAnalyticsSection({
  campaign,
  data,
  loading,
  error,
}: {
  campaign: Campaign;
  data: WebAnalyticsResponse | null;
  loading: boolean;
  error: string | null;
}): ReactElement {
  const isYoutube = (campaign.deliverable_type ?? 'blog') === 'youtube';
  const deliverableUrl = isYoutube ? campaign.youtube_url : campaign.blog_url;
  const noun = isYoutube ? 'video' : 'web';
  // While the type was just toggled the cached response may still describe the
  // other deliverable; only render blocks once the response matches.
  const dataMatches = data?.deliverable_type === (isYoutube ? 'youtube' : 'blog');

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-foreground">
        {isYoutube ? 'Video analytics' : 'Web analytics'}
      </h2>
      {!deliverableUrl ? (
        <p className="text-sm text-muted-foreground">
          {isYoutube
            ? 'Set a YouTube video URL on this campaign to pull views, likes, and comments.'
            : 'Set a blog post URL on this campaign to pull GA4 traffic and Core Web Vitals.'}
        </p>
      ) : (
        <>
          {error && <p className="form-error">Could not load {noun} analytics: {error}</p>}
          {loading && !dataMatches && (
            <p className="text-muted-foreground">Loading {noun} analytics...</p>
          )}
          {dataMatches && isYoutube && data?.youtube && <YoutubeBlock yt={data.youtube} />}
          {dataMatches && !isYoutube && (
            <>
              {data?.ga4 && <Ga4Block ga4={data.ga4} />}
              {data?.core_web_vitals && <CoreWebVitalsBlock cwv={data.core_web_vitals} />}
            </>
          )}
        </>
      )}
    </section>
  );
}

function YoutubeBlock({ yt }: { yt: YoutubeSection }): ReactElement {
  if (!yt.configured) {
    return <NotConnected label="YouTube" />;
  }
  if (yt.error || !yt.totals) {
    return (
      <div className="card card-body">
        <h3 className="text-sm font-semibold text-foreground mb-1">YouTube</h3>
        <p className="form-error">{yt.error ?? 'No data returned.'}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">
        {yt.title ? `YouTube: ${yt.title}` : 'YouTube'}
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Tile label="Views" value={yt.totals.views.toLocaleString()} />
        <Tile label="Likes" value={yt.totals.likes.toLocaleString()} />
        <Tile label="Comments" value={yt.totals.comments.toLocaleString()} />
        {yt.published_at && <Tile label="Published" value={yt.published_at.slice(0, 10)} />}
      </div>
    </div>
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
        <Tile label="Engagement" value={fmtPercentWhole(ga4.totals.engagement_rate)} />
        <Tile label="Avg. session" value={formatDuration(ga4.totals.avg_session_duration)} />
        <Tile label="Bounce rate" value={fmtPercentWhole(ga4.totals.bounce_rate)} />
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

function formatDuration(seconds: number): string {
  if (!seconds) return '0s';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

