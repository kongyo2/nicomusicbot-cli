import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authArgs,
  buildNiconicoCookieFile,
  classifyNiconicoUrl,
  fetchEntries,
  normalizeNiconicoUrl,
  normalizeSessionValue,
  parseTagRequest,
  resetNiconicoClientCache,
  resolveNativeAudioStream,
  searchByTag,
} from "./niconico.js";

function snapshotResponse(
  data: Array<Record<string, unknown>>,
  totalCount = data.length,
): Response {
  return Response.json({
    meta: { status: 200, totalCount, id: "test" },
    data,
  });
}

describe("niconico helpers", () => {
  beforeEach(() => {
    resetNiconicoClientCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes NicoNico video IDs and mobile URLs", () => {
    expect(normalizeNiconicoUrl("SM9")).toBe(
      "https://www.nicovideo.jp/watch/sm9",
    );
    expect(normalizeNiconicoUrl("https://sp.nicovideo.jp/watch/sm9")).toBe(
      "https://www.nicovideo.jp/watch/sm9",
    );
    expect(normalizeNiconicoUrl("<nico.ms/sm9>")).toBe(
      "https://www.nicovideo.jp/watch/sm9",
    );
  });

  it("prefers cookie auth over username/password", () => {
    expect(authArgs({})).toEqual([]);
    expect(
      authArgs({ niconicoUser: "user@example.test", niconicoPassword: "pw" }),
    ).toEqual(["--username", "user@example.test", "--password", "pw"]);
    expect(
      authArgs({
        niconicoUser: "user@example.test",
        niconicoPassword: "pw",
        cookiesPath: "/tmp/cookies.txt",
      }),
    ).toEqual(["--cookies", "/tmp/cookies.txt"]);
  });

  it("builds a Netscape cookie file from a session value", () => {
    const value =
      "user_session_00000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const file = buildNiconicoCookieFile(value);

    expect(file).toBeDefined();
    expect(file).toContain("# Netscape HTTP Cookie File");
    const cookieLine = file!
      .split("\n")
      .find((line) => line.includes("user_session"));
    expect(cookieLine).toBeDefined();
    const fields = cookieLine!.split("\t");
    expect(fields[0]).toBe(".nicovideo.jp");
    expect(fields[5]).toBe("user_session");
    expect(fields[6]).toBe(value);
  });

  it("normalizes pasted name=value and header cookie input", () => {
    const value = "user_session_1_abc";

    expect(normalizeSessionValue(`user_session=${value}`)).toBe(value);
    expect(normalizeSessionValue(`Cookie: user_session=${value}`)).toBe(value);
    expect(normalizeSessionValue(value)).toBe(value);
    expect(normalizeSessionValue("   ")).toBeUndefined();
    expect(normalizeSessionValue(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty session value", () => {
    expect(buildNiconicoCookieFile("")).toBeUndefined();
    expect(buildNiconicoCookieFile("   ")).toBeUndefined();
  });

  it("parses tag requests from plain text and tag URLs", () => {
    expect(parseTagRequest("vocaloid 250")).toEqual({
      tag: "vocaloid",
      limit: 100,
    });
    expect(
      parseTagRequest("https://www.nicovideo.jp/tag/%E9%9F%B3%E6%A5%BD 5"),
    ).toEqual({
      tag: "音楽",
      limit: 5,
    });
  });

  describe("classifyNiconicoUrl", () => {
    it("recognizes video references in every accepted shape", () => {
      for (const input of [
        "sm9",
        "SM9",
        "https://www.nicovideo.jp/watch/sm9",
        "https://nico.ms/sm9",
        "https://sp.nicovideo.jp/watch/sm9",
        "<https://www.nicovideo.jp/watch/sm9>",
      ]) {
        expect(classifyNiconicoUrl(input)).toEqual({
          kind: "video",
          videoId: "sm9",
        });
      }
    });

    it("recognizes collections", () => {
      expect(
        classifyNiconicoUrl("https://www.nicovideo.jp/mylist/79600395"),
      ).toEqual({ kind: "mylist", mylistId: "79600395" });
      expect(
        classifyNiconicoUrl("https://www.nicovideo.jp/user/123/mylist/456"),
      ).toEqual({ kind: "mylist", mylistId: "456" });
      expect(
        classifyNiconicoUrl("https://www.nicovideo.jp/series/176162"),
      ).toEqual({ kind: "series", seriesId: "176162" });
      expect(
        classifyNiconicoUrl("https://www.nicovideo.jp/user/9003560/video"),
      ).toEqual({ kind: "user", userId: "9003560" });
      expect(
        classifyNiconicoUrl("https://www.nicovideo.jp/tag/VOCALOID"),
      ).toEqual({ kind: "tag", tag: "VOCALOID" });
      expect(
        classifyNiconicoUrl(
          "https://www.nicovideo.jp/search/%E9%9F%B3%E6%A5%BD",
        ),
      ).toEqual({ kind: "search", keyword: "音楽" });
    });

    it("reads ranking genre, term, and tag from the URL", () => {
      expect(
        classifyNiconicoUrl(
          "https://www.nicovideo.jp/ranking/genre/music_sound?term=24h&tag=VOCALOID",
        ),
      ).toEqual({
        kind: "ranking",
        featuredKey: "music_sound",
        term: "24h",
        tag: "VOCALOID",
      });
      expect(classifyNiconicoUrl("https://www.nicovideo.jp/ranking")).toEqual({
        kind: "ranking",
      });
    });

    it("treats non-NicoNico and unparseable input as unknown", () => {
      expect(classifyNiconicoUrl("https://example.com/watch/sm9")).toEqual({
        kind: "unknown",
      });
      expect(classifyNiconicoUrl("")).toEqual({ kind: "unknown" });
      expect(classifyNiconicoUrl("https://www.nicovideo.jp/")).toEqual({
        kind: "unknown",
      });
    });
  });

  it("searches tags through the snapshot API", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        snapshotResponse([
          { contentId: "sm9", title: "title", lengthSeconds: 320 },
        ]),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(searchByTag("music", 1)).resolves.toEqual([
      { id: "sm9", title: "title", durationSeconds: 320 },
    ]);

    const requested = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requested.searchParams.get("q")).toBe("music");
    expect(requested.searchParams.get("targets")).toBe("tags");
    expect(requested.searchParams.get("_limit")).toBe("1");
  });

  it("retries transient tag search HTTP failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        snapshotResponse([{ contentId: "sm9", title: "title" }]),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(searchByTag("music", 1)).resolves.toEqual([
      { id: "sm9", title: "title" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries transient tag search network failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        snapshotResponse([{ contentId: "sm10", title: "network retry" }]),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(searchByTag("music", 1)).resolves.toEqual([
      { id: "sm10", title: "network retry" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a tag search failure as a descriptive error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("nope", { status: 400 })),
    );

    await expect(searchByTag("music", 1)).rejects.toThrow(
      /Tag search request failed/,
    );
  });

  it("resolves a single video without shelling out to yt-dlp", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        meta: { status: 200 },
        data: {
          items: [
            {
              watchId: "sm9",
              video: {
                id: "sm9",
                title: "レッツゴー！陰陽師",
                duration: 320,
                count: { view: 1, comment: 1, mylist: 1, like: 1 },
                thumbnail: { url: "https://example.test/t.jpg" },
                owner: null,
              },
            },
          ],
        },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchEntries("https://www.nicovideo.jp/watch/sm9", {}),
    ).resolves.toEqual([
      { id: "sm9", title: "レッツゴー！陰陽師", durationSeconds: 320 },
    ]);
  });

  // Regression: the API rejects sortKey=hot with an explicit sort direction,
  // which used to make every /search/ link fall back to yt-dlp.
  it("asks for relevance-sorted search results without a sort direction", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        meta: { status: 200 },
        data: {
          searchId: "s",
          totalCount: 1,
          hasNext: false,
          items: [{ id: "sm9", title: "hit", duration: 10 }],
          genres: [],
          additionalTags: [],
        },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchEntries("https://www.nicovideo.jp/search/vocaloid", {}),
    ).resolves.toEqual([{ id: "sm9", title: "hit", durationSeconds: 10 }]);

    const requested = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requested.searchParams.get("keyword")).toBe("vocaloid");
    expect(requested.searchParams.get("sortKey")).toBe("hot");
    expect(requested.searchParams.get("sortOrder")).toBe("none");
  });

  // Regression: NicoNico addresses genres by opaque key, so the readable "all"
  // slug in a pasted ranking URL used to 302 and fall back to yt-dlp.
  describe("ranking genre keys", () => {
    const rankingResponse = (featuredKey: string, label: string) =>
      Response.json({
        meta: { status: 200 },
        data: {
          response: {
            $getTeibanRanking: {
              data: {
                featuredKey,
                label,
                items: [{ id: "sm9", title: "ranked", duration: 10 }],
                hasNext: false,
              },
            },
            $getTeibanRankingFeaturedKeys: {
              data: {
                items: [
                  { featuredKey: "e9uj2uks", label: "総合", isEnabled: true },
                  { featuredKey: "wq76qdin", label: "音楽", isEnabled: true },
                ],
              },
            },
          },
        },
      });

    it("maps the 'all' slug to the overall ranking key in one request", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(rankingResponse("e9uj2uks", "総合"));

      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchEntries("https://www.nicovideo.jp/ranking/genre/all?term=24h", {}),
      ).resolves.toEqual([{ id: "sm9", title: "ranked", durationSeconds: 10 }]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("/genre/e9uj2uks");
    });

    it("passes a real opaque key straight through", async () => {
      // A fresh Response per call: a body can only be consumed once.
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => rankingResponse("wq76qdin", "音楽"));

      vi.stubGlobal("fetch", fetchMock);

      await fetchEntries(
        "https://www.nicovideo.jp/ranking/genre/wq76qdin?term=24h",
        {},
      );

      // First request looks the genre list up, second fetches that ranking.
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
        "/genre/wq76qdin",
      );
    });

    it("falls back to the overall ranking for an unknown slug", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => rankingResponse("e9uj2uks", "総合"));

      vi.stubGlobal("fetch", fetchMock);

      await fetchEntries(
        "https://www.nicovideo.jp/ranking/genre/music_sound",
        {},
      );

      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
        "/genre/e9uj2uks",
      );
    });
  });

  it("requests an audio-only stream and returns the CDN headers", async () => {
    const watchPayload = {
      meta: { status: 200 },
      data: {
        video: { id: "sm9", title: "陰陽師", duration: 320 },
        media: {
          domand: {
            accessRightKey: "key-123",
            isStoryboardAvailable: false,
            videos: [
              {
                id: "video-h264-360p",
                isAvailable: true,
                qualityLevel: 2,
                recommendedHighestAudioQualityLevel: 2,
              },
            ],
            audios: [
              {
                id: "audio-aac-64kbps",
                isAvailable: true,
                bitRate: 64000,
                qualityLevel: 1,
              },
              {
                id: "audio-aac-128kbps",
                isAvailable: true,
                bitRate: 128000,
                qualityLevel: 2,
              },
            ],
          },
        },
        okReason: "OK",
        client: { watchTrackId: "track" },
      },
    };

    const accessRightsResponse = Response.json({
      meta: { status: 201 },
      data: { contentUrl: "https://delivery.example.test/audio.m3u8" },
    });
    accessRightsResponse.headers.append(
      "set-cookie",
      "domand_bid=bid-value; Path=/",
    );

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(watchPayload))
      .mockResolvedValueOnce(accessRightsResponse);

    vi.stubGlobal("fetch", fetchMock);

    const stream = await resolveNativeAudioStream({ id: "sm9" }, {});

    expect(stream).toMatchObject({
      videoId: "sm9",
      title: "陰陽師",
      durationSeconds: 320,
      contentUrl: "https://delivery.example.test/audio.m3u8",
      // The highest-quality available rendition wins.
      audioStreamId: "audio-aac-128kbps",
      audioBitRate: 128000,
    });
    expect(stream.headers).toMatchObject({
      Origin: "https://www.nicovideo.jp",
      Referer: "https://www.nicovideo.jp/",
    });

    // Crucially: no videoStreamId in the outputs, so the CDN serves audio only.
    const accessRightsInit = fetchMock.mock.calls[1][1];
    expect(JSON.parse(String(accessRightsInit?.body))).toEqual({
      outputs: [["audio-aac-128kbps"]],
    });
  });

  it("rejects a video with no streamable rendition", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          meta: { status: 200 },
          data: {
            video: { id: "so123", title: "paid", duration: 60 },
            media: { domand: null },
            okReason: "PPV_VIDEO",
            client: { watchTrackId: "track" },
          },
        }),
      ),
    );

    await expect(resolveNativeAudioStream({ id: "so123" }, {})).rejects.toThrow(
      /no DMS stream/,
    );
  });

  it("refuses to resolve a non-video reference", async () => {
    await expect(
      resolveNativeAudioStream({ id: "https://www.nicovideo.jp/mylist/1" }, {}),
    ).rejects.toThrow(/not a NicoNico video reference/);
  });
});
