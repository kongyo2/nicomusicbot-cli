import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NiconicoUnplayableError,
  authArgs,
  buildNiconicoCookieFile,
  checkNiconicoSession,
  classifyNiconicoUrl,
  fetchEntries,
  makeTrackUrl,
  normalizeNiconicoUrl,
  normalizeSessionValue,
  parseTagRequest,
  resetNiconicoClientCache,
  resolveNativeAudioStream,
  searchByTag,
  ytDlpMayPlayRefusedVideo,
} from "./niconico.js";

// Unit tests never shell out: yt-dlp behaves as if it were not installed, so
// the fallback fails fast and the same way on every machine.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");

  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter();

      setImmediate(() => {
        child.emit(
          "error",
          Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" }),
        );
      });

      return child;
    }),
  };
});

const SESSION = "user_session_1_0123456789abcdef";

function snapshotResponse(
  data: Array<Record<string, unknown>>,
  totalCount = data.length,
): Response {
  return Response.json({
    meta: { status: 200, totalCount, id: "test" },
    data,
  });
}

function apiError(
  status: number,
  errorCode: string,
  data?: Record<string, unknown>,
): Response {
  return Response.json(
    { meta: { status, errorCode }, ...(data ? { data } : {}) },
    { status },
  );
}

const DEFAULT_MEDIA = {
  contents: {
    videos: [{ id: "video-h264-360p", isAvailable: true, qualityLevel: 2 }],
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
  accessRightKey: "key-123",
  hls: null,
  isStoryboardAvailable: false,
};

function watchV4Response(
  overrides: {
    videoId?: string;
    media?: unknown;
    viewer?: unknown;
    okReason?: string;
    payment?: unknown;
  } = {},
): Response {
  const videoId = overrides.videoId ?? "sm9";

  return Response.json({
    meta: { status: 200 },
    data: {
      client: { nicosid: "nicosid", watchId: videoId, watchTrackId: "track" },
      video: { id: videoId, title: "陰陽師", duration: 320 },
      media: "media" in overrides ? overrides.media : DEFAULT_MEDIA,
      lazy: { authKey: "lazy-key" },
      okReason: overrides.okReason ?? "PURELY",
      viewer: overrides.viewer ?? null,
      payment: overrides.payment ?? { watchableUserType: "all" },
    },
  });
}

const VIEWER = { id: 1, nickname: "tester", isPremium: false };

function accessRightsResponse(): Response {
  const response = Response.json({
    meta: { status: 201 },
    data: { contentUrl: "https://delivery.example.test/audio.m3u8" },
  });
  response.headers.append("set-cookie", "domand_bid=bid-value; Path=/");
  return response;
}

function mylistResponse(videoIds: string[]): Response {
  return Response.json({
    meta: { status: 200 },
    data: {
      mylist: {
        id: 1,
        items: videoIds.map((id, index) => ({
          itemId: index + 1,
          watchId: id,
          video: { id, title: `title ${id}`, duration: 60 },
        })),
        totalItemCount: videoIds.length,
        hasNext: false,
      },
    },
  });
}

type FetchCall = Parameters<typeof fetch>;

function requestUrl(call: FetchCall): string {
  return String(call[0]);
}

function requestHeaders(call: FetchCall): Headers {
  return new Headers(call[1]?.headers);
}

function requestBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
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
    expect(
      normalizeSessionValue(`Cookie: nicosid=1; user_session=${value}; a=b`),
    ).toBe(value);
    expect(normalizeSessionValue("   ")).toBeUndefined();
    expect(normalizeSessionValue(undefined)).toBeUndefined();
  });

  it("treats a value that is not a user_session cookie as no session", () => {
    expect(normalizeSessionValue("not-a-session")).toBeUndefined();
    expect(buildNiconicoCookieFile("not-a-session")).toBeUndefined();
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

    it("recognizes short videos and their /shorts/ URLs", () => {
      for (const input of [
        "ss46171060",
        "https://www.nicovideo.jp/shorts/ss46171060",
        "https://sp.nicovideo.jp/shorts/ss46171060",
        "https://nico.ms/ss46171060",
        "https://www.nicovideo.jp/watch/ss46171060",
        "<https://www.nicovideo.jp/shorts/ss46171060?ref=share>",
      ]) {
        expect(classifyNiconicoUrl(input)).toEqual({
          kind: "video",
          videoId: "ss46171060",
        });
      }
    });

    it("rewrites /shorts/ to /watch/, which yt-dlp understands", () => {
      expect(
        normalizeNiconicoUrl("https://www.nicovideo.jp/shorts/ss46171060"),
      ).toBe("https://www.nicovideo.jp/watch/ss46171060");
      expect(normalizeNiconicoUrl("ss46171060")).toBe(
        "https://www.nicovideo.jp/watch/ss46171060",
      );
      expect(makeTrackUrl({ id: "ss46171060" })).toBe(
        "https://www.nicovideo.jp/watch/ss46171060",
      );
    });

    it("recognizes the watch-later page", () => {
      expect(
        classifyNiconicoUrl("https://www.nicovideo.jp/my/watchlater"),
      ).toEqual({ kind: "watch-later" });
      expect(
        classifyNiconicoUrl(
          "https://www.nicovideo.jp/my/watchlater?ref=pc_mypage_menu",
        ),
      ).toEqual({ kind: "watch-later" });
      expect(
        classifyNiconicoUrl("https://www.nicovideo.jp/my/mylist/79722258"),
      ).toEqual({ kind: "mylist", mylistId: "79722258" });
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
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => rankingResponse("wq76qdin", "音楽"));

      vi.stubGlobal("fetch", fetchMock);

      await fetchEntries(
        "https://www.nicovideo.jp/ranking/genre/wq76qdin?term=24h",
        {},
      );

      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
        "/genre/wq76qdin",
      );
    });

    it("translates a legacy readable slug to its current genre key", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => rankingResponse("wq76qdin", "音楽"));

      vi.stubGlobal("fetch", fetchMock);

      await fetchEntries(
        "https://www.nicovideo.jp/ranking/genre/music_sound",
        {},
      );

      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
        "/genre/wq76qdin",
      );
    });

    it("resolves a genre label as well as a slug", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => rankingResponse("wq76qdin", "音楽"));

      vi.stubGlobal("fetch", fetchMock);

      await fetchEntries("https://www.nicovideo.jp/ranking/genre/音楽", {});

      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
        "/genre/wq76qdin",
      );
    });

    it("warns instead of silently substituting for an unrecognized genre", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => rankingResponse("e9uj2uks", "総合"));
      const log = vi.fn();

      vi.stubGlobal("fetch", fetchMock);

      await fetchEntries(
        "https://www.nicovideo.jp/ranking/genre/not_a_genre",
        {},
        { log },
      );

      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
        "/genre/e9uj2uks",
      );
      expect(log).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining('Unknown ranking genre "not_a_genre"'),
      );
    });
  });

  it("pages through a series longer than one request", async () => {
    const seriesPage = (page: number, totalCount: number) =>
      Response.json({
        meta: { status: 200 },
        data: {
          detail: { id: 1, title: "long series" },
          totalCount,
          items: Array.from({ length: 100 }, (_, index) => ({
            meta: { id: `m${page}-${index}` },
            video: {
              id: `sm${page}${String(index).padStart(3, "0")}`,
              title: `track ${page}-${index}`,
              duration: 60,
            },
          })),
        },
      });

    let page = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      page += 1;
      return seriesPage(page, 250);
    });

    vi.stubGlobal("fetch", fetchMock);

    const entries = await fetchEntries(
      "https://www.nicovideo.jp/series/176162",
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(entries).toHaveLength(250);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(250);
  });

  describe("collections that need the session owner's account", () => {
    it("reads a private mylist through the session owner's route", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(apiError(403, "FORBIDDEN"))
        .mockResolvedValueOnce(mylistResponse(["ss46171060", "sm9"]));
      const log = vi.fn();

      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchEntries(
          "https://www.nicovideo.jp/my/mylist/79722258",
          { niconicoSession: SESSION },
          { log },
        ),
      ).resolves.toEqual([
        { id: "ss46171060", title: "title ss46171060", durationSeconds: 60 },
        { id: "sm9", title: "title sm9", durationSeconds: 60 },
      ]);
      expect(requestUrl(fetchMock.mock.calls[0])).toContain(
        "/v2/mylists/79722258",
      );
      expect(requestUrl(fetchMock.mock.calls[1])).toContain(
        "/v1/users/me/mylists/79722258",
      );
      expect(log).toHaveBeenCalledWith(
        "info",
        expect.stringContaining("is private"),
      );
    });

    it("says a private mylist needs its owner's session when playing as a guest", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(apiError(403, "FORBIDDEN"));

      vi.stubGlobal("fetch", fetchMock);

      const error = (await fetchEntries(
        "https://www.nicovideo.jp/mylist/79722258",
        {},
      ).catch((caught: unknown) => caught)) as Error;

      expect(error.message).toMatch(
        /Mylist 79722258 is private; only its owner's NicoNico session can play it/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("says so when a private mylist belongs to another account", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(apiError(403, "FORBIDDEN"))
          .mockResolvedValueOnce(apiError(404, "NOT_FOUND")),
      );

      const error = (await fetchEntries(
        "https://www.nicovideo.jp/mylist/79722258",
        { niconicoSession: SESSION },
      ).catch((caught: unknown) => caught)) as Error;

      expect(error.message).toMatch(
        /does not belong to the account of the configured NicoNico session/,
      );
    });

    it("plays the session owner's watch-later list", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          meta: { status: 200 },
          data: {
            watchLater: {
              items: [
                {
                  itemId: 1,
                  watchId: "sm9",
                  video: { id: "sm9", title: "one", duration: 10 },
                },
                {
                  itemId: 2,
                  watchId: "ss46171060",
                  video: { id: "ss46171060", title: "short", duration: 11 },
                },
              ],
              totalCount: 2,
              hasNext: false,
              hasInvisibleItems: false,
            },
          },
        }),
      );

      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchEntries("https://www.nicovideo.jp/my/watchlater", {
          niconicoSession: SESSION,
        }),
      ).resolves.toEqual([
        { id: "sm9", title: "one", durationSeconds: 10 },
        { id: "ss46171060", title: "short", durationSeconds: 11 },
      ]);
      expect(requestUrl(fetchMock.mock.calls[0])).toContain(
        "/v1/users/me/watch-later",
      );
      expect(requestHeaders(fetchMock.mock.calls[0]).get("cookie")).toBe(
        `user_session=${SESSION}`,
      );
    });

    it("needs a session for the watch-later list", async () => {
      const fetchMock = vi.fn<typeof fetch>();

      vi.stubGlobal("fetch", fetchMock);

      const error = (await fetchEntries(
        "https://www.nicovideo.jp/my/watchlater",
        {},
      ).catch((caught: unknown) => caught)) as Error;

      expect(error.message).toMatch(/configure a NicoNico session cookie/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("resolveNativeAudioStream", () => {
    it("requests an audio-only stream from v4 watch data as a guest", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(watchV4Response())
        .mockResolvedValueOnce(accessRightsResponse());

      vi.stubGlobal("fetch", fetchMock);

      const stream = await resolveNativeAudioStream({ id: "sm9" }, {});

      expect(stream).toMatchObject({
        videoId: "sm9",
        title: "陰陽師",
        durationSeconds: 320,
        contentUrl: "https://delivery.example.test/audio.m3u8",
        audioStreamId: "audio-aac-128kbps",
        audioBitRate: 128000,
        guest: true,
      });
      expect(stream.headers).toMatchObject({
        Origin: "https://www.nicovideo.jp",
        Referer: "https://www.nicovideo.jp/",
        Cookie: "domand_bid=bid-value",
      });

      const [watchCall, rightsCall] = fetchMock.mock.calls;

      expect(requestUrl(watchCall)).toBe(
        "https://nvapi.nicovideo.jp/v4/watch/sm9",
      );
      expect(watchCall[1]?.method).toBe("POST");
      expect(requestBody(watchCall)).toMatchObject({ asGuest: true });
      expect(requestBody(rightsCall)).toEqual({
        outputs: [["audio-aac-128kbps"]],
      });
      // The access right key is bound to the watch call's actionTrackId.
      expect(
        new URL(requestUrl(rightsCall)).searchParams.get("actionTrackId"),
      ).toBe(requestBody(watchCall).actionTrackId);
    });

    it("watches with the session cookie when one is configured", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(watchV4Response({ viewer: VIEWER }))
        .mockResolvedValueOnce(accessRightsResponse());

      vi.stubGlobal("fetch", fetchMock);

      const stream = await resolveNativeAudioStream(
        { id: "sm9" },
        { niconicoSession: SESSION },
      );
      const [watchCall, rightsCall] = fetchMock.mock.calls;

      expect(stream.guest).toBe(false);
      expect(requestBody(watchCall)).not.toHaveProperty("asGuest");
      expect(requestHeaders(watchCall).get("cookie")).toBe(
        `user_session=${SESSION}`,
      );
      expect(requestHeaders(rightsCall).get("cookie")).toBe(
        `user_session=${SESSION}`,
      );
    });

    it("falls back to guest watch data, sent without the cookie, when the session is rejected", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(apiError(400, "UNAUTHORIZED"))
        .mockResolvedValueOnce(watchV4Response())
        .mockResolvedValueOnce(accessRightsResponse());

      vi.stubGlobal("fetch", fetchMock);

      const stream = await resolveNativeAudioStream(
        { id: "sm9" },
        { niconicoSession: SESSION },
      );
      const [, guestWatchCall, rightsCall] = fetchMock.mock.calls;

      expect(stream.guest).toBe(true);
      expect(requestBody(guestWatchCall)).toMatchObject({ asGuest: true });
      expect(requestHeaders(guestWatchCall).has("cookie")).toBe(false);
      // A guest access key presented with a session cookie is a 400.
      expect(requestHeaders(rightsCall).has("cookie")).toBe(false);
    });

    it("plays a short video by its ss ID", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(watchV4Response({ videoId: "ss46171060" }))
        .mockResolvedValueOnce(accessRightsResponse());

      vi.stubGlobal("fetch", fetchMock);

      await expect(
        resolveNativeAudioStream(
          { url: "https://www.nicovideo.jp/shorts/ss46171060" },
          {},
        ),
      ).resolves.toMatchObject({ videoId: "ss46171060" });
      expect(requestUrl(fetchMock.mock.calls[0])).toBe(
        "https://nvapi.nicovideo.jp/v4/watch/ss46171060",
      );
    });

    it("records the view only when asked, through the v4 side-effect route", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(watchV4Response({ viewer: VIEWER }))
        .mockResolvedValueOnce(accessRightsResponse())
        .mockResolvedValueOnce(Response.json({ meta: { status: 200 } }));

      vi.stubGlobal("fetch", fetchMock);

      const stream = await resolveNativeAudioStream(
        { id: "sm9" },
        { niconicoSession: SESSION },
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);

      await stream.recordView();

      const [watchCall, , sideEffectCall] = fetchMock.mock.calls;

      expect(requestUrl(sideEffectCall)).toBe(
        "https://nvapi.nicovideo.jp/v4/watch/sm9/side-effect",
      );
      expect(requestBody(sideEffectCall)).toEqual({
        actionTrackId: requestBody(watchCall).actionTrackId,
      });
    });

    it.each([
      [
        403,
        "FORBIDDEN",
        "ADMINISTRATOR_DELETE_VIDEO",
        /deleted by the NicoNico administrators/,
        false,
      ],
      [
        403,
        "FORBIDDEN",
        "RIGHT_HOLDER_DELETE_VIDEO",
        /deleted at the rights holder's request/,
        false,
      ],
      [403, "FORBIDDEN", "DELETED_VIDEO", /has been deleted/, false],
      [404, "NOT_FOUND", "NOT_FOUND", /no video exists with this ID/, false],
      [
        403,
        "FORBIDDEN",
        "SOMETHING_NEW",
        /refused the video \(SOMETHING_NEW\)/,
        true,
      ],
    ])(
      "explains a %i %s refusal with reasonCode %s",
      async (status, errorCode, reasonCode, reason, accountDependent) => {
        const fetchMock = vi
          .fn<typeof fetch>()
          .mockResolvedValue(apiError(status, errorCode, { reasonCode }));

        vi.stubGlobal("fetch", fetchMock);

        const error = await resolveNativeAudioStream({ id: "sm1" }, {}).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(NiconicoUnplayableError);
        expect(error).toMatchObject({ accountDependent });
        expect((error as NiconicoUnplayableError).reason).toMatch(reason);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it("leaves a refusal that is not about the video to the yt-dlp fallback", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            apiError(403, "FORBIDDEN", { errorDetail: "AB001" }),
          ),
      );

      const error = await resolveNativeAudioStream({ id: "sm9" }, {}).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NiconicoUnplayableError);
    });

    it.each([
      ["member", /only channel members can play this video/],
      ["purchaser", /has to be purchased/],
      [
        "somebody",
        /okReason=PAYMENT_PREVIEW_SUPPORTED, watchableUserType=somebody/,
      ],
    ])(
      "names what a %s-only video needs",
      async (watchableUserType, reason) => {
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>().mockResolvedValue(
            watchV4Response({
              videoId: "so123",
              media: null,
              okReason: "PAYMENT_PREVIEW_SUPPORTED",
              payment: { watchableUserType },
            }),
          ),
        );

        const error = await resolveNativeAudioStream({ id: "so123" }, {}).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(NiconicoUnplayableError);
        expect(error).toMatchObject({ accountDependent: true });
        expect((error as NiconicoUnplayableError).reason).toMatch(reason);
      },
    );

    it("refuses to resolve a non-video reference", async () => {
      await expect(
        resolveNativeAudioStream(
          { id: "https://www.nicovideo.jp/mylist/1" },
          {},
        ),
      ).rejects.toThrow(/not a NicoNico video reference/);
    });
  });

  describe("ytDlpMayPlayRefusedVideo", () => {
    const membersOnly = new NiconicoUnplayableError(
      "so123",
      "only channel members can play this video",
      { accountDependent: true },
    );
    const deleted = new NiconicoUnplayableError(
      "sm1",
      "the video was deleted by the NicoNico administrators",
    );
    const password = {
      niconicoUser: "user@example.test",
      niconicoPassword: "pw",
    };

    it("retries an account-dependent refusal when yt-dlp signs in with a password", () => {
      expect(ytDlpMayPlayRefusedVideo(membersOnly, password)).toBe(true);
    });

    it("never retries a video that is gone for everyone", () => {
      expect(ytDlpMayPlayRefusedVideo(deleted, password)).toBe(false);
    });

    it("skips yt-dlp when it would watch as the same viewer", () => {
      // The session cookie file wins over the password, as in authArgs.
      expect(
        ytDlpMayPlayRefusedVideo(membersOnly, {
          ...password,
          niconicoSession: SESSION,
          cookiesPath: "/tmp/cookies.txt",
        }),
      ).toBe(false);
      expect(ytDlpMayPlayRefusedVideo(membersOnly, {})).toBe(false);
      expect(
        ytDlpMayPlayRefusedVideo(membersOnly, {
          niconicoUser: "user@example.test",
        }),
      ).toBe(false);
    });
  });

  describe("checkNiconicoSession", () => {
    it("reports a missing or malformed session without asking NicoNico", async () => {
      const fetchMock = vi.fn<typeof fetch>();

      vi.stubGlobal("fetch", fetchMock);

      await expect(checkNiconicoSession(undefined)).resolves.toEqual({
        status: "none",
      });
      await expect(checkNiconicoSession("   ")).resolves.toEqual({
        status: "none",
      });
      await expect(checkNiconicoSession("not-a-session")).resolves.toEqual({
        status: "malformed",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("tells a rejected cookie apart from a working one", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(apiError(401, "UNAUTHORIZED")),
      );

      await expect(checkNiconicoSession(SESSION)).resolves.toMatchObject({
        status: "rejected",
        reason: expect.stringContaining("401"),
      });

      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            meta: { status: 200 },
            data: {
              userId: "1",
              nickname: "tester",
              hasPremiumOrStrongerRights: true,
              icons: { urls: { "150x150": "https://example.test/icon.jpg" } },
            },
          }),
        ),
      );

      await expect(checkNiconicoSession(SESSION)).resolves.toEqual({
        status: "verified",
        nickname: "tester",
        isPremium: true,
      });
    });

    it("throws on a transport failure instead of discarding the cookie", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")),
      );

      await expect(checkNiconicoSession(SESSION)).rejects.toThrow();
    }, 20_000);
  });

  it("reports both failures when the yt-dlp fallback also fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("nope", { status: 404 })),
    );

    const error = (await fetchEntries(
      "https://www.nicovideo.jp/mylist/1",
      {},
    ).catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/NicoNico mylist lookup failed/);
    expect(error.message).toMatch(/yt-dlp fallback failed/);
    expect(error.cause).toBeDefined();
  });
});
