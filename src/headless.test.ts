import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHeadless } from "./headless.js";
import type {
  BotConfig,
  DependencyCheck,
  DependencySetupResult,
} from "./types.js";

const okChecks: DependencyCheck[] = [
  {
    name: "yt-dlp",
    command: "yt-dlp",
    ok: true,
    details: "Found in PATH.",
    required: true,
  },
  {
    name: "ffmpeg",
    command: "ffmpeg",
    ok: true,
    details: "Found in PATH.",
    required: true,
  },
  {
    name: "opus backend",
    command: "opusscript",
    ok: true,
    details: "Available.",
    required: false,
  },
];

type MemoryStream = NodeJS.WriteStream & {
  output: () => string;
};

function memoryStream(): MemoryStream {
  let output = "";

  return {
    write: vi.fn((message: string | Uint8Array) => {
      output += message.toString();
      return true;
    }),
    output: () => output,
  } as unknown as MemoryStream;
}

function makeOptions(configPath: string, overrides: Partial<BotConfig> = {}) {
  return {
    help: false,
    autoStart: false,
    profile: "default",
    configPath,
    saveConfigOverride: false,
    savePreferenceLocked: true,
    overrides,
  };
}

describe("runHeadless", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  async function tempConfigPath(): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "nicomusicbot-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, "config.json");
  }

  it("prints validation errors instead of rendering Ink in non-interactive mode", async () => {
    const stderr = memoryStream();
    const exitCode = await runHeadless(makeOptions(await tempConfigPath()), {
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.output()).toContain(
      "Cannot start NicomusicBot in non-interactive mode.",
    );
    expect(stderr.output()).toContain("Discord token is required.");
  });

  it("starts and stops the service when non-interactive config is valid", async () => {
    const stdout = memoryStream();
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const createService = vi.fn(() => ({ start, stop }));
    const autoSetupPrerequisites = vi.fn(
      async (): Promise<DependencySetupResult> => ({
        attempted: false,
        changed: false,
        logs: [],
      }),
    );

    const exitCode = await runHeadless(
      makeOptions(await tempConfigPath(), {
        token: "discord-token",
        prefix: "!",
      }),
      {
        stdout,
        checkPrerequisites: async () => okChecks,
        autoSetupPrerequisites,
        createService,
        waitForShutdown: async ({ service }) => {
          await service.stop();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(createService).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(autoSetupPrerequisites).not.toHaveBeenCalled();
    expect(stdout.output()).toContain(
      "NicomusicBot is running in non-interactive mode.",
    );
  });

  it("uses the injected dependency checker again after automatic setup", async () => {
    const missingChecks = okChecks.map((check) =>
      check.command === "yt-dlp"
        ? { ...check, ok: false, details: "Not found in PATH." }
        : check,
    );
    const checkPrerequisites = vi
      .fn<() => Promise<DependencyCheck[]>>()
      .mockResolvedValueOnce(missingChecks)
      .mockResolvedValueOnce(okChecks);
    const autoSetupPrerequisites = vi.fn(
      async (): Promise<DependencySetupResult> => ({
        attempted: true,
        changed: true,
        logs: ["Installed yt-dlp."],
      }),
    );

    const exitCode = await runHeadless(
      makeOptions(await tempConfigPath(), {
        token: "discord-token",
        prefix: "!",
      }),
      {
        stdout: memoryStream(),
        checkPrerequisites,
        autoSetupPrerequisites,
        createService: () => ({
          start: async () => undefined,
          stop: async () => undefined,
        }),
        waitForShutdown: async ({ service }) => {
          await service.stop();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(checkPrerequisites).toHaveBeenCalledTimes(2);
    expect(autoSetupPrerequisites).toHaveBeenCalledWith(missingChecks);
  });
});
