import { jest } from "@jest/globals";

process.env.ENVIRONMENT = "staging";

jest.unstable_mockModule("../services/ga-secrets.mjs", () => ({
  readYoutubeApiKey: jest.fn(),
}));
jest.unstable_mockModule("../services/youtube.mjs", () => ({
  extractYoutubeVideoId: jest.fn(),
  fetchVideoStats: jest.fn(),
}));

const secrets = await import("../services/ga-secrets.mjs");
const youtube = await import("../services/youtube.mjs");
const { loadCampaignYoutube } = await import("../services/campaign-youtube.mjs");

const STATS = {
  video_id: "dQw4w9WgXcQ",
  title: "Demo",
  channel_title: "Chan",
  published_at: "2026-03-01T00:00:00Z",
  thumbnail_url: "https://i.ytimg.com/vi/x/mqdefault.jpg",
  totals: { views: 100, likes: 10, comments: 2, favorites: 0 },
};

beforeEach(() => {
  jest.clearAllMocks();
  youtube.extractYoutubeVideoId.mockReturnValue("dQw4w9WgXcQ");
});

describe("loadCampaignYoutube", () => {
  test("returns null when the campaign isn't a YouTube deliverable", async () => {
    expect(await loadCampaignYoutube({ deliverableType: "blog", youtubeUrl: "https://youtu.be/x" }))
      .toBeNull();
    expect(await loadCampaignYoutube({ deliverableType: "youtube" })).toBeNull();
    expect(secrets.readYoutubeApiKey).not.toHaveBeenCalled();
  });

  test("returns null when the URL has no parseable video id", async () => {
    youtube.extractYoutubeVideoId.mockReturnValue(null);
    expect(await loadCampaignYoutube({ deliverableType: "youtube", youtubeUrl: "https://youtu.be/" }))
      .toBeNull();
  });

  test("reports unconfigured when no API key is stored", async () => {
    secrets.readYoutubeApiKey.mockResolvedValue(null);
    const out = await loadCampaignYoutube({
      deliverableType: "youtube",
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(out).toEqual({
      configured: false,
      error: null,
      youtube_url: "https://youtu.be/dQw4w9WgXcQ",
      video_id: "dQw4w9WgXcQ",
    });
    expect(youtube.fetchVideoStats).not.toHaveBeenCalled();
  });

  test("returns stats on a successful fetch", async () => {
    secrets.readYoutubeApiKey.mockResolvedValue("key");
    youtube.fetchVideoStats.mockResolvedValue(STATS);
    const out = await loadCampaignYoutube({
      deliverableType: "youtube",
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(out).toEqual({
      configured: true,
      error: null,
      youtube_url: "https://youtu.be/dQw4w9WgXcQ",
      ...STATS,
    });
  });

  test("reports an error when the video is missing / private", async () => {
    secrets.readYoutubeApiKey.mockResolvedValue("key");
    youtube.fetchVideoStats.mockResolvedValue(null);
    const out = await loadCampaignYoutube({
      deliverableType: "youtube",
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(out.configured).toBe(true);
    expect(out.error).toMatch(/not found/i);
  });

  test("swallows upstream failures into a structured error", async () => {
    secrets.readYoutubeApiKey.mockResolvedValue("key");
    youtube.fetchVideoStats.mockRejectedValue(new Error("quota exceeded"));
    const out = await loadCampaignYoutube({
      deliverableType: "youtube",
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(out).toEqual({
      configured: true,
      error: "quota exceeded",
      youtube_url: "https://youtu.be/dQw4w9WgXcQ",
      video_id: "dQw4w9WgXcQ",
    });
  });
});
