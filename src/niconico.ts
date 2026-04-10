import { spawn } from "node:child_process";
import { err, fromPromise, ok, type Result } from "neverthrow";
import type { TrackEntry } from "./types.js";

type NicoAuth = {
  niconicoUser?: string;
  niconicoPassword?: string;
};

const VIDEO_ID_PREFIXES = [
  "sm",
  "nm",
  "so",
  "ax",
  "yo",
  "nl",
  "ig",
  "na",
  "cw",
  "zb",
  "z9",
] as const;

function authArgs(auth: NicoAuth): string[] {
  if (auth.niconicoUser && auth.niconicoPassword) {
    return [
      "--username",
      auth.niconicoUser,
      "--password",
      auth.niconicoPassword,
    ];
  }

  return [];
}

async function runCommand(
  command: string,
  args: string[],
): Promise<
  Result<
    { stdout: string; stderr: string; exitCode: number },
    Error
  >
> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve(err(new Error(`Failed to spawn "${command}": ${error.message}`)));
    });
    child.on("close", (exitCode) => {
      resolve(
        ok({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
        }),
      );
    });
  });
}

function isVideoId(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    VIDEO_ID_PREFIXES.some((prefix) => normalized.startsWith(prefix)) &&
    /^\d+$/.test(normalized.slice(2))
  );
}

export function normalizeNiconicoUrl(input: string): string {
  let url = input.trim().replace(/^<|>$/g, "");

  if (!url) {
    return url;
  }

  if (/^https?:\/\/nico\.ms\//i.test(url)) {
    url = url.split("://", 2)[1] ?? url;
  }

  if (isVideoId(url)) {
    return `https://www.nicovideo.jp/watch/${url.toLowerCase()}`;
  }

  if (/^nico\.ms\//i.test(url)) {
    const path = url.slice("nico.ms/".length);

    if (isVideoId(path)) {
      return `https://www.nicovideo.jp/watch/${path.toLowerCase()}`;
    }

    return `https://www.nicovideo.jp/${path}`;
  }

  url = url.replace(/:\/\/sp\.nicovideo\.jp/i, "://www.nicovideo.jp");

  if (/^sp\.nicovideo\.jp/i.test(url)) {
    return `https://www.${url.slice("sp.".length)}`;
  }

  if (!/^https?:\/\//i.test(url)) {
    if (/^nicovideo\.jp/i.test(url)) {
      return `https://www.${url}`;
    }

    return `https://${url}`;
  }

  if (/^https?:\/\/nicovideo\.jp/i.test(url)) {
    return url.replace(/:\/\/nicovideo\.jp/i, "://www.nicovideo.jp");
  }

  return url;
}

export function makeTrackUrl(entry: TrackEntry): string | undefined {
  const value = entry.id ?? entry.url ?? entry.webpageUrl;

  if (!value) {
    return undefined;
  }

  return normalizeNiconicoUrl(value);
}

async function runYtDlpJson(args: string[]): Promise<Result<TrackEntry[], Error>> {
  const result = await runCommand("yt-dlp", args);

  if (result.isErr()) {
    return err(result.error);
  }

  if (result.value.exitCode !== 0 && !result.value.stdout.trim()) {
    return err(
      new Error(
        `yt-dlp exited with code ${result.value.exitCode}: ${result.value.stderr.trim() || "no stderr output"}`,
      ),
    );
  }

  const entries = result.value.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;

        return [
          {
            id: typeof parsed.id === "string" ? parsed.id : undefined,
            title: typeof parsed.title === "string" ? parsed.title : undefined,
            url: typeof parsed.url === "string" ? parsed.url : undefined,
            webpageUrl:
              typeof parsed.webpage_url === "string"
                ? parsed.webpage_url
                : undefined,
          } satisfies TrackEntry,
        ];
      } catch {
        return [];
      }
    });

  return ok(entries);
}

export async function fetchEntries(
  url: string,
  auth: NicoAuth,
): Promise<TrackEntry[]> {
  const baseArgs = ["--dump-json", "-q", "--ignore-errors", ...authArgs(auth)];
  let entriesResult = await runYtDlpJson([
    ...baseArgs,
    "--flat-playlist",
    normalizeNiconicoUrl(url),
  ]);

  if (entriesResult.isErr()) {
    throw entriesResult.error;
  }

  if (entriesResult.value.length === 0) {
    entriesResult = await runYtDlpJson([...baseArgs, normalizeNiconicoUrl(url)]);
  }

  if (entriesResult.isErr()) {
    throw entriesResult.error;
  }

  return entriesResult.value;
}

export async function resolveTrackTitle(
  entry: TrackEntry,
  auth: NicoAuth,
): Promise<string | undefined> {
  if (entry.title && !isVideoId(entry.title)) {
    return entry.title;
  }

  const url = makeTrackUrl(entry);

  if (!url) {
    return entry.title;
  }

  const metadataResult = await runYtDlpJson([
    "--dump-json",
    "-q",
    "--no-playlist",
    ...authArgs(auth),
    url,
  ]);

  if (metadataResult.isErr()) {
    return entry.title;
  }

  return metadataResult.value[0]?.title ?? entry.title;
}

function extractTagFromInput(input: string): string {
  const cleaned = input.trim().replace(/^<|>$/g, "");

  if (!cleaned.includes("/tag/")) {
    return cleaned;
  }

  const tagPath = cleaned.split("/tag/", 2)[1]?.split("?", 1)[0] ?? cleaned;

  try {
    return decodeURIComponent(tagPath);
  } catch {
    return tagPath;
  }
}

export function parseTagRequest(raw: string): { tag: string; limit: number } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let limit = 30;

  if (tokens.length > 1) {
    const maybeLimit = tokens.at(-1);

    if (maybeLimit && /^\d+$/.test(maybeLimit)) {
      limit = Number.parseInt(maybeLimit, 10);
      tokens.pop();
    }
  }

  return {
    tag: extractTagFromInput(tokens.join(" ")),
    limit: Math.max(1, Math.min(limit || 30, 100)),
  };
}

export async function searchByTag(
  tagInput: string,
  limit: number,
): Promise<TrackEntry[]> {
  const tag = extractTagFromInput(tagInput);
  const url = new URL(
    "https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search",
  );

  url.search = new URLSearchParams({
    q: tag,
    targets: "tags",
    fields: "contentId,title",
    _sort: "-startTime",
    _limit: String(Math.max(1, Math.min(limit, 100))),
    _context: "NicomusicBotCLI",
  }).toString();

  const responseResult = await fromPromise(
    fetch(url, {
      headers: {
        "User-Agent": "NicomusicBotCLI/0.1.0",
      },
    }),
    (error) =>
      new Error(
        `Tag search request failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  );

  if (responseResult.isErr()) {
    throw responseResult.error;
  }

  const response = responseResult.value;

  if (!response.ok) {
    throw new Error(`Tag search API returned ${response.status}.`);
  }

  const jsonResult = await fromPromise(
    response.json(),
    (error) =>
      new Error(
        `Failed to decode tag search response: ${error instanceof Error ? error.message : String(error)}`,
      ),
  );

  if (jsonResult.isErr()) {
    throw jsonResult.error;
  }

  const data = jsonResult.value as {
    data?: Array<{
      contentId?: string;
      title?: string;
    }>;
  };

  return (data.data ?? []).flatMap((item) => {
    if (!item.contentId) {
      return [];
    }

    return [
      {
        id: item.contentId,
        title: item.title ?? item.contentId,
      } satisfies TrackEntry,
    ];
  });
}
