import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  draftToConfig,
  loadInitialDraft,
  maskSecret,
  parseCliOptions,
  saveConfigToDisk,
  validateDraft,
} from "./config.js";

describe("config", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();

    for (const tempDir of tempDirs.splice(0)) {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  async function tempPath(file = "config.json"): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "nicomusicbot-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, file);
  }

  it("parses CLI overrides and save preferences", () => {
    const configPath = path.join("relative", "config.json");
    const options = parseCliOptions([
      "--token",
      "discord-token",
      "--prefix",
      "!!",
      "--niconico-user",
      "user@example.test",
      "--niconico-password",
      "secret",
      "--config",
      configPath,
      "--skip-menu",
      "--no-save-config",
    ]);

    expect(options).toMatchObject({
      help: false,
      autoStart: true,
      saveConfigOverride: false,
      savePreferenceLocked: true,
      overrides: {
        token: "discord-token",
        prefix: "!!",
        niconicoUser: "user@example.test",
        niconicoPassword: "secret",
      },
    });
    expect(options.configPath).toBe(path.resolve(configPath));
  });

  it("keeps the legacy config path for the default profile", () => {
    const configHome = path.join(os.tmpdir(), "nicomusicbot-config-home");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    const options = parseCliOptions([]);

    expect(options.profile).toBe("default");
    expect(options.configPath).toBe(
      path.join(configHome, "nicomusicbot", "config.json"),
    );
  });

  it("resolves named profiles under the profiles directory", () => {
    const configHome = path.join(os.tmpdir(), "nicomusicbot-config-home");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    const options = parseCliOptions(["--profile", "work"]);

    expect(options.profile).toBe("work");
    expect(options.configPath).toBe(
      path.join(configHome, "nicomusicbot", "profiles", "work.json"),
    );
  });

  it("allows an environment-selected profile and a CLI path override", () => {
    vi.stubEnv("NICOMUSICBOT_PROFILE", "stage");
    const configPath = path.join("custom", "stage.json");

    const options = parseCliOptions(["--config", configPath]);

    expect(options.profile).toBe("stage");
    expect(options.configPath).toBe(path.resolve(configPath));
  });

  it("rejects profile names that would escape the profile directory", () => {
    expect(() => parseCliOptions(["--profile", "../secret"])).toThrow(
      "Profile name cannot contain path separators.",
    );
  });

  it("merges persisted config, environment, and CLI overrides in priority order", async () => {
    const configPath = await tempPath();
    await writeFile(
      configPath,
      JSON.stringify({
        token: "persisted-token",
        prefix: "?",
        niconicoUser: "persisted-user",
        niconicoPassword: "persisted-password",
      }),
      "utf8",
    );
    vi.stubEnv("DISCORD_TOKEN", "env-token");
    vi.stubEnv("NICOMUSICBOT_PREFIX", "$");

    const result = await loadInitialDraft({
      ...parseCliOptions(["--config", configPath]),
      overrides: {
        niconicoUser: "cli-user",
      },
    });

    expect(result.loadedFromFile).toBe(true);
    expect(result.validationIssues).toEqual([]);
    expect(result.draft).toMatchObject({
      profile: "default",
      token: "env-token",
      prefix: "$",
      niconicoUser: "cli-user",
      niconicoPassword: "persisted-password",
      saveConfig: true,
      configPath,
    });
  });

  it("validates required fields and paired NicoNico credentials", () => {
    expect(
      validateDraft({
        profile: "default",
        token: "",
        prefix: "",
        niconicoUser: "user@example.test",
        niconicoPassword: "",
        saveConfig: false,
        configPath: "/tmp/config.json",
      }),
    ).toEqual([
      "Discord token is required.",
      "Command prefix is required.",
      "NicoNico login requires both username/email and password, or neither.",
    ]);
  });

  it("normalizes optional credentials when creating the runtime config", () => {
    expect(
      draftToConfig({
        token: " token ",
        prefix: " ! ",
        niconicoUser: "   ",
        niconicoPassword: "   ",
        saveConfig: false,
        profile: "default",
        configPath: "/tmp/config.json",
      }),
    ).toEqual({
      profile: "default",
      token: "token",
      prefix: "!",
      niconicoUser: undefined,
      niconicoPassword: undefined,
      configPath: "/tmp/config.json",
    });
  });

  it("writes only persisted config fields to disk", async () => {
    const configPath = await tempPath("nested/config.json");
    await saveConfigToDisk({
      token: "token",
      prefix: "!",
      niconicoUser: "user",
      niconicoPassword: "password",
      profile: "default",
      configPath,
    });

    await expect(readFile(configPath, "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          token: "token",
          prefix: "!",
          niconicoUser: "user",
          niconicoPassword: "password",
        },
        null,
        2,
      )}\n`,
    );
  });

  it("masks secrets without exposing complete values", () => {
    expect(maskSecret("")).toBe("not set");
    expect(maskSecret("abcdef")).toBe("ab***ef");
    expect(maskSecret("abcdefghijkl")).toBe("abcd...ijkl");
  });
});
