import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "./runtime-store.js";

describe("RuntimeStore", () => {
  let store: RuntimeStore;

  beforeEach(() => {
    store = new RuntimeStore("!", "/tmp/config.json");
  });

  it("initializes dashboard state", () => {
    expect(store.getState()).toMatchObject({
      status: "idle",
      dependencies: [],
      guilds: [],
      logs: [],
      prefix: "!",
      configPath: "/tmp/config.json",
    });
  });

  it("notifies subscribers until they unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setStatus("running");
    unsubscribe();
    store.setStatus("stopped");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("updates status, progress, dependencies, and connected user", () => {
    const dependency = {
      name: "yt-dlp",
      command: "yt-dlp",
      ok: true,
      details: "Found.",
      required: true,
    };

    store.setStatus("error", "boom");
    store.setProgress({ label: "Starting", value: 50 });
    store.setDependencies([dependency]);
    store.setConnectedUser("bot#0001");

    expect(store.getState()).toMatchObject({
      status: "error",
      error: "boom",
      progress: { label: "Starting", value: 50 },
      dependencies: [dependency],
      connectedUser: "bot#0001",
    });

    store.setProgress(undefined);
    store.setConnectedUser(undefined);

    expect(store.getState().progress).toBeUndefined();
    expect(store.getState().connectedUser).toBeUndefined();
  });

  it("sorts, updates, removes, and clears guild snapshots", () => {
    store.upsertGuild({
      guildId: "b",
      guildName: "Beta",
      queueLength: 1,
      volume: 100,
      muted: false,
      state: "idle",
    });
    store.upsertGuild({
      guildId: "a",
      guildName: "Alpha",
      queueLength: 2,
      volume: 50,
      muted: false,
      state: "playing",
    });
    store.upsertGuild({
      guildId: "b",
      guildName: "Beta",
      queueLength: 3,
      volume: 75,
      muted: true,
      state: "error",
      lastError: "failed",
    });

    expect(store.getState().guilds.map((guild) => guild.guildId)).toEqual([
      "a",
      "b",
    ]);
    expect(store.getState().guilds[1]).toMatchObject({
      guildId: "b",
      queueLength: 3,
      muted: true,
      lastError: "failed",
    });

    store.removeGuild("a");
    expect(store.getState().guilds.map((guild) => guild.guildId)).toEqual([
      "b",
    ]);

    store.clearGuilds();
    expect(store.getState().guilds).toEqual([]);
  });

  it("keeps only the most recent 200 logs", () => {
    for (let index = 0; index < 205; index += 1) {
      store.addLog("info", `message ${index}`);
    }

    const logs = store.getState().logs;

    expect(logs).toHaveLength(200);
    expect(logs[0]).toMatchObject({ id: 6, message: "message 5" });
    expect(logs.at(-1)).toMatchObject({ id: 205, message: "message 204" });
  });
});
