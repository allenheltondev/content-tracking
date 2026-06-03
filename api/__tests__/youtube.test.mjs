import { jest } from "@jest/globals";
import { extractYoutubeVideoId, fetchVideoStats } from "../services/youtube.mjs";
import { UpstreamError } from "../services/errors.mjs";

function fakeResponse({ ok = true, status = 200, body = {} }) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe("extractYoutubeVideoId", () => {
  test("parses the common URL forms", () => {
    const id = "dQw4w9WgXcQ";
    expect(extractYoutubeVideoId(`https://www.youtube.com/watch?v=${id}`)).toBe(id);
    expect(extractYoutubeVideoId(`https://youtube.com/watch?v=${id}&t=42s`)).toBe(id);
    expect(extractYoutubeVideoId(`https://youtu.be/${id}`)).toBe(id);
    expect(extractYoutubeVideoId(`https://www.youtube.com/shorts/${id}`)).toBe(id);
    expect(extractYoutubeVideoId(`https://www.youtube.com/embed/${id}`)).toBe(id);
    expect(extractYoutubeVideoId(`https://www.youtube.com/live/${id}`)).toBe(id);
    expect(extractYoutubeVideoId(`https://www.youtube-nocookie.com/embed/${id}`)).toBe(id);
  });

  test("returns null for non-YouTube hosts and malformed URLs", () => {
    expect(extractYoutubeVideoId("https://vimeo.com/12345")).toBeNull();
    expect(extractYoutubeVideoId("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractYoutubeVideoId("https://www.youtube.com/watch")).toBeNull();
    expect(extractYoutubeVideoId("https://youtu.be/")).toBeNull();
    expect(extractYoutubeVideoId("not a url")).toBeNull();
    // An id of the wrong length is rejected.
    expect(extractYoutubeVideoId("https://youtu.be/short")).toBeNull();
  });
});

describe("fetchVideoStats", () => {
  afterEach(() => {
    delete global.fetch;
  });

  test("maps snippet + statistics into the section shape", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(fakeResponse({
      body: {
        items: [
          {
            snippet: {
              title: "How to ship faster",
              channelTitle: "Ready, Set, Cloud!",
              publishedAt: "2026-03-01T12:00:00Z",
              thumbnails: { medium: { url: "https://i.ytimg.com/vi/x/mqdefault.jpg" } },
            },
            statistics: { viewCount: "15234", likeCount: "812", commentCount: "47" },
          },
        ],
      },
    }));

    const result = await fetchVideoStats({ videoId: "dQw4w9WgXcQ", apiKey: "k" });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      video_id: "dQw4w9WgXcQ",
      title: "How to ship faster",
      channel_title: "Ready, Set, Cloud!",
      published_at: "2026-03-01T12:00:00Z",
      thumbnail_url: "https://i.ytimg.com/vi/x/mqdefault.jpg",
      totals: { views: 15234, likes: 812, comments: 47, favorites: 0 },
    });
  });

  test("hidden like/comment counts read as 0", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(fakeResponse({
      body: { items: [{ snippet: { title: "x" }, statistics: { viewCount: "10" } }] },
    }));
    const result = await fetchVideoStats({ videoId: "dQw4w9WgXcQ", apiKey: "k" });
    expect(result.totals).toEqual({ views: 10, likes: 0, comments: 0, favorites: 0 });
  });

  test("returns null when the video is missing / private (empty items)", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(fakeResponse({ body: { items: [] } }));
    expect(await fetchVideoStats({ videoId: "dQw4w9WgXcQ", apiKey: "k" })).toBeNull();
  });

  test("throws UpstreamError on a non-ok response", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 403, body: { error: "quota" } }),
    );
    await expect(fetchVideoStats({ videoId: "dQw4w9WgXcQ", apiKey: "k" })).rejects.toThrow(
      UpstreamError,
    );
  });
});
