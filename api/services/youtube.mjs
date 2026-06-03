import { logger } from "./logger.mjs";
import { UpstreamError } from "./errors.mjs";

// Thin client for the YouTube Data API v3. Public video stats (views,
// likes, comments) need only a plain Google API key — the same kind of key
// the Core Web Vitals client uses, just with the YouTube Data API enabled.
// The key is passed in by the caller (loaded from SSM in the route) so this
// module stays a pure HTTP client, testable without touching AWS.

const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

// Pulls the 11-character video id out of any common YouTube URL form:
//   youtube.com/watch?v=ID, youtu.be/ID, /shorts/ID, /embed/ID, /live/ID,
//   /v/ID, plus the youtube-nocookie.com embed host.
// Returns null when the URL isn't a recognizable YouTube video link.
export function extractYoutubeVideoId(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const isYoutube =
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be" ||
    host === "youtube-nocookie.com";
  if (!isYoutube) return null;

  let id = null;
  if (host === "youtu.be") {
    id = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (parsed.pathname === "/watch") {
    id = parsed.searchParams.get("v");
  } else {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && ["shorts", "embed", "live", "v"].includes(parts[0])) {
      id = parts[1];
    }
  }

  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

// Fetch public snippet + statistics for one video. Returns null when the
// video doesn't exist or is private (the API returns an empty items array
// rather than a 404 for an unknown id). likeCount / commentCount can be
// hidden by the uploader, in which case they're absent and read as 0.
export async function fetchVideoStats({ videoId, apiKey }) {
  const params = new URLSearchParams({
    part: "snippet,statistics",
    id: videoId,
    key: apiKey,
  });

  const response = await fetch(`${VIDEOS_URL}?${params}`, { method: "GET" });
  const text = await response.text();
  if (!response.ok) {
    logger.error("YouTube videos.list failed", { videoId, status: response.status, body: text });
    throw new UpstreamError(`YouTube API failed: ${text}`, response.status);
  }

  const json = JSON.parse(text);
  const item = json.items?.[0];
  if (!item) return null;

  const stats = item.statistics ?? {};
  const snippet = item.snippet ?? {};
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  return {
    video_id: videoId,
    title: snippet.title ?? null,
    channel_title: snippet.channelTitle ?? null,
    published_at: snippet.publishedAt ?? null,
    thumbnail_url:
      snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.default?.url ?? null,
    totals: {
      views: num(stats.viewCount),
      likes: num(stats.likeCount),
      comments: num(stats.commentCount),
      favorites: num(stats.favoriteCount),
    },
  };
}
