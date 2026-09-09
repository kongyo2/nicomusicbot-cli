import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  NicomusicBotService,
  autoSetupPrerequisites,
  checkPrerequisites,
  waitForSpawn,
} from "./bot-service.js";
import { RuntimeStore } from "./runtime-store.js";
import type { BotConfig, DependencyCheck } from "./types.js";

function config(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    profile: "default",
    token: "discord-token",
    prefix: "!",
    configPath: "/tmp/config.json",
    ...overrides,
  };
}

describe("bot-service exports", () => {
  it("reports available runtime prerequisites", async () => {
    await expect(checkPrerequisites()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "yt-dlp",
          ok: true,
          // Playback resolves through @kongyo2/niconicojs, so yt-dlp is only a
          // fallback and must not block startup.
          required: false,
          autoInstall: true,
        }),
        expect.objectContaining({
          command: "ffmpeg",
          ok: true,
          required: true,
          autoInstall: true,
        }),
        expect.objectContaining({
          command: "@discordjs/opus | node-opus | opusscript",
          ok: true,
          required: false,
        }),
      ]),
    );
  });

  it("does not run auto setup when installable checks are already OK", async () => {
    const checks: DependencyCheck[] = [
      {
        name: "yt-dlp",
        command: "yt-dlp",
        ok: true,
        details: "Found.",
        required: false,
        autoInstall: true,
      },
    ];

    await expect(autoSetupPrerequisites(checks)).resolves.toEqual({
      attempted: false,
      changed: false,
      logs: [],
    });
  });

  it("never tries to install a check that is not marked installable", async () => {
    const checks: DependencyCheck[] = [
      {
        name: "opus backend",
        command: "@discordjs/opus | node-opus | opusscript",
        ok: false,
        details: "Missing.",
        required: false,
      },
    ];

    await expect(autoSetupPrerequisites(checks)).resolves.toEqual({
      attempted: false,
      changed: false,
      logs: [],
    });
  });

  // Regression: spawn() reports a missing binary asynchronously, so the stdio
  // streams look healthy and playback used to be announced for a track that
  // then silently ended. Matters now that yt-dlp is optional.
  describe("waitForSpawn", () => {
    it("rejects when the binary is missing", async () => {
      const child = spawn("nicomusicbot-no-such-binary", ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("error", () => undefined);

      // The old guard checked this and would have let the track through.
      expect(child.stdout).not.toBeNull();

      await expect(waitForSpawn(child, "yt-dlp")).rejects.toThrow(
        /Could not start yt-dlp.*ENOENT/s,
      );
    });

    it("resolves once a real binary starts", async () => {
      const child = spawn(process.execPath, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("error", () => undefined);

      await expect(waitForSpawn(child, "node")).resolves.toBeUndefined();
      child.kill();
    });
  });

  it("builds NicoNico auth args only when both credentials are configured", () => {
    const store = new RuntimeStore("!", "/tmp/config.json");

    expect(new NicomusicBotService(config(), store).authArgs()).toEqual([]);
    expect(
      new NicomusicBotService(
        config({
          niconicoUser: "user@example.test",
          niconicoPassword: "password",
        }),
        store,
      ).authArgs(),
    ).toEqual(["--username", "user@example.test", "--password", "password"]);
  });
});
