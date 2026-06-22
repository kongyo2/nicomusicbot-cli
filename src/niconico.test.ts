import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authArgs,
  buildNiconicoCookieFile,
  normalizeNiconicoUrl,
  parseTagRequest,
  searchByTag,
} from "./niconico.js";

describe("niconico helpers", () => {
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
    const fromPair = buildNiconicoCookieFile(`user_session=${value}`);
    const fromHeader = buildNiconicoCookieFile(`Cookie: user_session=${value}`);

    for (const file of [fromPair, fromHeader]) {
      const fields = file!
        .split("\n")
        .find((line) => line.includes("user_session"))!
        .split("\t");
      expect(fields[6]).toBe(value);
    }
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

  it("retries transient tag search HTTP failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          data: [{ contentId: "sm9", title: "title" }],
        }),
      );
    const sleep = vi.fn(async () => undefined);

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchByTag("music", 1, {
        sleep,
        baseDelayMs: 10,
      }),
    ).resolves.toEqual([{ id: "sm9", title: "title" }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("retries transient tag search network failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        Response.json({
          data: [{ contentId: "sm10", title: "network retry" }],
        }),
      );
    const sleep = vi.fn(async () => undefined);

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchByTag("music", 1, {
        sleep,
        baseDelayMs: 10,
      }),
    ).resolves.toEqual([{ id: "sm10", title: "network retry" }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });
});
