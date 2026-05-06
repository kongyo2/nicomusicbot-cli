import { describe, expect, it } from "vitest";
import {
  NicomusicBotService,
  autoSetupPrerequisites,
  checkPrerequisites,
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
          required: true,
        }),
        expect.objectContaining({
          command: "ffmpeg",
          ok: true,
          required: true,
        }),
        expect.objectContaining({
          command: "@discordjs/opus | node-opus | opusscript",
          ok: true,
          required: false,
        }),
      ]),
    );
  });

  it("does not run auto setup when required checks are already OK", async () => {
    const checks: DependencyCheck[] = [
      {
        name: "yt-dlp",
        command: "yt-dlp",
        ok: true,
        details: "Found.",
        required: true,
      },
    ];

    await expect(autoSetupPrerequisites(checks)).resolves.toEqual({
      attempted: false,
      changed: false,
      logs: [],
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
