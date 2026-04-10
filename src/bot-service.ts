import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  AudioPlayerStatus,
  DiscordGatewayAdapterCreator,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  Guild,
  GuildMember,
  GuildTextBasedChannel,
  Message,
  VoiceBasedChannel,
  VoiceState,
} from "discord.js";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  fetchEntries,
  makeTrackUrl,
  normalizeNiconicoUrl,
  parseTagRequest,
  resolveTrackTitle,
  searchByTag,
} from "./niconico.js";
import { RuntimeStore } from "./runtime-store.js";
import type {
  BotConfig,
  DependencyCheck,
  GuildPlaybackStatus,
  GuildSnapshot,
  LogLevel,
  TrackEntry,
} from "./types.js";

const execFileAsync = promisify(execFile);

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function clampVolume(level: number): number {
  return Math.max(0, Math.min(level, 300));
}

function truncateDiscordMessage(content: string): string {
  return content.length <= 1900 ? content : `${content.slice(0, 1897)}...`;
}

async function sendWithRetry(
  channel: GuildTextBasedChannel,
  content: string,
): Promise<void> {
  const payload = truncateDiscordMessage(content);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await channel.send(payload);
      return;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.status === 429 && attempt < 3) {
        await sleep(10_000 * 2 ** attempt);
        continue;
      }

      return;
    }
  }
}

async function commandExists(command: string): Promise<boolean> {
  const locator = process.platform === "win32" ? "where.exe" : "which";

  try {
    await execFileAsync(locator, [command]);
    return true;
  } catch {
    return false;
  }
}

export async function checkPrerequisites(): Promise<DependencyCheck[]> {
  const checks = await Promise.all([
    commandExists("yt-dlp"),
    commandExists("ffmpeg"),
  ]);

  return [
    {
      name: "yt-dlp",
      command: "yt-dlp",
      ok: checks[0],
      details: checks[0] ? "Found in PATH." : "Not found in PATH.",
    },
    {
      name: "ffmpeg",
      command: "ffmpeg",
      ok: checks[1],
      details: checks[1] ? "Found in PATH." : "Not found in PATH.",
    },
  ];
}

class GuildController {
  private readonly player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  private connection?: ReturnType<typeof joinVoiceChannel>;
  private textChannel?: GuildTextBasedChannel;
  private queue: TrackEntry[] = [];
  private current?: TrackEntry;
  private ytDlpProcess?: ChildProcess;
  private ffmpegProcess?: ChildProcess;
  private ignoreNextIdle = false;
  private volume = 1;
  private savedVolume?: number;
  private playbackStatus: GuildPlaybackStatus = "idle";
  private lastError?: string;
  private sequence = Promise.resolve();

  constructor(
    private readonly service: NicomusicBotService,
    private readonly guild: Guild,
  ) {
    this.player.on(AudioPlayerStatus.Idle, () => {
      void this.serialize(async () => {
        await this.handlePlayerIdle();
      });
    });

    this.player.on("error", (error) => {
      this.lastError = error.message;
      this.playbackStatus = "error";
      this.updateSnapshot();
      this.service.log(
        "error",
        `[${this.guild.name}] Playback error: ${error.message}`,
      );
      void this.notify(`Playback error: ${error.message}`);
    });
  }

  getConnectionChannelId(): string | undefined {
    return this.connection?.joinConfig.channelId ?? undefined;
  }

  getVolumePercent(): number {
    return Math.round(this.volume * 100);
  }

  isPlaying(): boolean {
    return this.player.state.status !== AudioPlayerStatus.Idle;
  }

  async connect(member: GuildMember, channel: GuildTextBasedChannel): Promise<void> {
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) {
      throw new Error("Join a voice channel before running this command.");
    }

    this.textChannel = channel;
    this.playbackStatus = "connecting";
    this.lastError = undefined;
    this.updateSnapshot();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: member.guild.id,
          adapterCreator:
            member.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
          selfDeaf: false,
        });

        this.connection = connection;
        this.connection.subscribe(this.player);
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

        this.playbackStatus = this.player.state.status === AudioPlayerStatus.Idle
          ? "idle"
          : "playing";
        this.lastError = undefined;
        this.updateSnapshot();
        return;
      } catch (error) {
        this.lastError = formatError(error);
        this.service.log(
          "warn",
          `[${this.guild.name}] Voice connect retry ${attempt}/3 failed: ${this.lastError}`,
        );

        if (
          this.connection &&
          this.connection.state.status !== VoiceConnectionStatus.Destroyed
        ) {
          this.connection.destroy();
        }

        this.connection = undefined;

        if (attempt === 3) {
          this.playbackStatus = "error";
          this.updateSnapshot();
          throw new Error("Failed to connect to the voice channel.");
        }

        await sleep(2_000);
      }
    }
  }

  enqueueEntries(entries: TrackEntry[], requestedBy?: string): void {
    for (const entry of entries) {
      this.queue.push({
        ...entry,
        requestedBy,
      });
    }

    this.updateSnapshot();
  }

  async playIfIdle(): Promise<void> {
    await this.serialize(async () => {
      await this.advanceQueue();
    });
  }

  async skip(): Promise<boolean> {
    if (this.player.state.status === AudioPlayerStatus.Idle) {
      return false;
    }

    await this.serialize(async () => {
      await this.stopForManualTransition();
      await this.advanceQueue();
    });

    return true;
  }

  async destroy(): Promise<void> {
    await this.serialize(async () => {
      this.queue = [];
      await this.stopForManualTransition();

      if (
        this.connection &&
        this.connection.state.status !== VoiceConnectionStatus.Destroyed
      ) {
        this.connection.destroy();
      }

      this.connection = undefined;
      this.textChannel = undefined;
      this.current = undefined;
      this.lastError = undefined;
      this.playbackStatus = "idle";
      this.service.store.removeGuild(this.guild.id);
    });
  }

  async setVolume(level: number): Promise<number> {
    const clamped = clampVolume(level);
    this.volume = clamped / 100;

    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.state.resource.volume?.setVolume(this.volume);
    }

    this.updateSnapshot();
    return clamped;
  }

  async toggleMute(): Promise<number> {
    if (this.volume === 0) {
      this.volume = this.savedVolume ?? 1;
      this.savedVolume = undefined;
    } else {
      this.savedVolume = this.volume;
      this.volume = 0;
    }

    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.state.resource.volume?.setVolume(this.volume);
    }

    this.updateSnapshot();
    return this.getVolumePercent();
  }

  describeQueue(): string {
    const lines: string[] = [];

    if (this.current) {
      const currentUrl = makeTrackUrl(this.current);
      lines.push(`Now playing: ${this.current.title ?? this.current.id ?? "Unknown"}`);

      if (currentUrl) {
        lines.push(currentUrl);
      }
    }

    if (this.queue.length === 0) {
      if (lines.length === 0) {
        return "Queue is empty.";
      }

      lines.push("Queue is empty.");
      return lines.join("\n");
    }

    lines.push(`Queue (${this.queue.length}):`);

    for (const [index, entry] of this.queue.slice(0, 10).entries()) {
      const title = entry.title ?? entry.id ?? "Unknown";
      const url = makeTrackUrl(entry);
      lines.push(`${index + 1}. ${title}`);

      if (url) {
        lines.push(`   ${url}`);
      }
    }

    if (this.queue.length > 10) {
      lines.push(`... and ${this.queue.length - 10} more`);
    }

    return lines.join("\n");
  }

  updateSnapshot(): void {
    const textChannelName =
      this.textChannel && "name" in this.textChannel ? this.textChannel.name : undefined;
    const voiceChannel = this.resolveVoiceChannel();
    const snapshot: GuildSnapshot = {
      guildId: this.guild.id,
      guildName: this.guild.name,
      voiceChannelName: voiceChannel?.name,
      textChannelName,
      queueLength: this.queue.length,
      currentTitle: this.current?.title ?? this.current?.id,
      currentUrl: this.current ? makeTrackUrl(this.current) : undefined,
      volume: this.getVolumePercent(),
      muted: this.volume === 0,
      state: this.playbackStatus,
      requestedBy: this.current?.requestedBy,
      lastError: this.lastError,
    };

    this.service.store.upsertGuild(snapshot);
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const next = this.sequence.then(task, task);
    this.sequence = next.catch(() => undefined);
    return next;
  }

  private async handlePlayerIdle(): Promise<void> {
    if (this.ignoreNextIdle) {
      this.ignoreNextIdle = false;
      return;
    }

    this.cleanupProcesses();
    this.current = undefined;
    this.playbackStatus = "idle";
    this.updateSnapshot();
    await this.advanceQueue();
  }

  private async stopForManualTransition(): Promise<void> {
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.ignoreNextIdle = true;
      this.player.stop(true);
      await entersState(this.player, AudioPlayerStatus.Idle, 5_000).catch(() => undefined);
    }

    this.cleanupProcesses();
    this.current = undefined;
    this.playbackStatus = "idle";
    this.updateSnapshot();
  }

  private cleanupProcesses(): void {
    if (this.ytDlpProcess && !this.ytDlpProcess.killed) {
      this.ytDlpProcess.kill();
    }

    if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
      this.ffmpegProcess.kill();
    }

    this.ytDlpProcess = undefined;
    this.ffmpegProcess = undefined;
  }

  private resolveVoiceChannel(): VoiceBasedChannel | undefined {
    const channelId = this.connection?.joinConfig.channelId;

    if (!channelId) {
      return undefined;
    }

    const channel = this.guild.channels.cache.get(channelId);

    return channel?.isVoiceBased() ? channel : undefined;
  }

  private async advanceQueue(): Promise<void> {
    if (!this.connection) {
      return;
    }

    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      return;
    }

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);

    while (this.queue.length > 0) {
      const next = this.queue.shift();

      if (!next) {
        break;
      }

      const url = makeTrackUrl(next);

      if (!url) {
        await this.notify(
          `Skipped track because no playable NicoNico URL could be resolved: ${next.title ?? next.id ?? "Unknown"}`,
        );
        continue;
      }

      try {
        const title =
          (await resolveTrackTitle(next, this.service.config)) ??
          next.title ??
          next.id ??
          "Unknown";
        const ytDlp = this.spawnYtDlp(url);
        const ffmpeg = this.spawnFfmpeg();

        if (!ytDlp.stdout || !ffmpeg.stdin || !ffmpeg.stdout) {
          throw new Error("Audio pipeline could not be created.");
        }

        ytDlp.stdout.pipe(ffmpeg.stdin);
        ytDlp.on("close", () => {
          ffmpeg.stdin?.end();
        });

        this.ytDlpProcess = ytDlp;
        this.ffmpegProcess = ffmpeg;

        const resource = createAudioResource(ffmpeg.stdout, {
          inputType: StreamType.Raw,
          inlineVolume: true,
        });

        resource.volume?.setVolume(this.volume);
        this.current = {
          ...next,
          title,
          url,
        };
        this.playbackStatus = "playing";
        this.lastError = undefined;
        this.connection.subscribe(this.player);
        this.player.play(resource);
        this.updateSnapshot();
        this.service.log("success", `[${this.guild.name}] Now playing ${title}`);
        await this.notify(`Now playing: ${title}\n${url}`);
        return;
      } catch (error) {
        this.lastError = formatError(error);
        this.playbackStatus = "error";
        this.updateSnapshot();
        this.service.log(
          "error",
          `[${this.guild.name}] Failed to start track: ${this.lastError}`,
        );
        await this.notify(
          `Failed to play ${next.title ?? next.id ?? "Unknown"}: ${this.lastError}`,
        );
        this.cleanupProcesses();
      }
    }

    this.current = undefined;
    this.playbackStatus = "idle";
    this.updateSnapshot();
  }

  private spawnYtDlp(url: string): ChildProcess {
    return spawn(
      "yt-dlp",
      [
        "-q",
        "-f",
        "bestaudio[abr<=128]/bestaudio",
        "--no-playlist",
        "-o",
        "-",
        ...this.service.authArgs(),
        url,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  }

  private spawnFfmpeg(): ChildProcess {
    return spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "pipe:1",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  }

  private async notify(message: string): Promise<void> {
    if (!this.textChannel) {
      return;
    }

    await sendWithRetry(this.textChannel, message);
  }
}

export class NicomusicBotService {
  readonly store: RuntimeStore;
  readonly config: BotConfig;

  private client?: Client;
  private readonly guildControllers = new Map<string, GuildController>();

  constructor(config: BotConfig, store: RuntimeStore) {
    this.config = config;
    this.store = store;
  }

  log(level: LogLevel, message: string): void {
    this.store.addLog(level, message);
  }

  authArgs(): string[] {
    if (this.config.niconicoUser && this.config.niconicoPassword) {
      return [
        "--username",
        this.config.niconicoUser,
        "--password",
        this.config.niconicoPassword,
      ];
    }

    return [];
  }

  async start(): Promise<void> {
    if (this.client) {
      return;
    }

    this.store.setStatus("starting");
    this.store.setProgress({
      label: "Waiting for Discord API availability",
      value: 60,
    });
    this.log("info", "Preparing Discord client...");
    await this.waitForDiscordApi();

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client = client;
    this.registerHandlers(client);

    try {
      const readyPromise = once(client, Events.ClientReady);

      this.store.setProgress({
        label: "Logging into Discord",
        value: 80,
      });
      await client.login(this.config.token);

      const [readyClient] = await readyPromise;

      this.store.setConnectedUser(readyClient.user.tag);
      this.store.setProgress({
        label: "Bot is ready",
        value: 100,
      });
      this.store.setStatus("running");
      this.log("success", `Logged in as ${readyClient.user.tag}.`);
    } catch (error) {
      this.store.setStatus("error", formatError(error));
      this.store.setProgress(undefined);
      this.log("error", `Discord login failed: ${formatError(error)}`);
      client.destroy();
      this.client = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.client) {
      this.store.setStatus("stopped");
      return;
    }

    this.store.setStatus("stopping");
    this.store.setProgress(undefined);
    this.log("info", "Stopping bot...");

    for (const [guildId, controller] of [...this.guildControllers.entries()]) {
      await controller.destroy();
      this.guildControllers.delete(guildId);
    }

    this.client.destroy();
    this.client = undefined;
    this.store.clearGuilds();
    this.store.setConnectedUser(undefined);
    this.store.setStatus("stopped");
    this.log("success", "Bot stopped.");
  }

  private registerHandlers(client: Client): void {
    client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message);
    });

    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      void this.handleVoiceStateUpdate(oldState, newState);
    });
  }

  private getOrCreateGuildController(guild: Guild): GuildController {
    let controller = this.guildControllers.get(guild.id);

    if (!controller) {
      controller = new GuildController(this, guild);
      this.guildControllers.set(guild.id, controller);
    }

    return controller;
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || !message.guild || !message.member) {
      return;
    }

    const content = message.content.trim();

    if (!content.startsWith(this.config.prefix)) {
      return;
    }

    const body = content.slice(this.config.prefix.length).trim();

    if (!body) {
      return;
    }

    const [rawCommand, ..._] = body.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const rest = body.slice(rawCommand.length).trim();
    const channel = message.channel as GuildTextBasedChannel;

    try {
      switch (command) {
        case "play":
          await this.handlePlayCommand(message, channel, rest);
          break;
        case "tag":
          await this.handleTagCommand(message, channel, rest);
          break;
        case "skip":
          await this.handleSkipCommand(message, channel);
          break;
        case "queue":
          await this.handleQueueCommand(message, channel);
          break;
        case "stop":
          await this.handleStopCommand(message, channel);
          break;
        case "volume":
          await this.handleVolumeCommand(message, channel, rest);
          break;
        case "mute":
          await this.handleMuteCommand(message, channel);
          break;
        default:
          break;
      }
    } catch (error) {
      const details = formatError(error);
      this.log("error", `[${message.guild.name}] ${command}: ${details}`);
      await sendWithRetry(channel, `Command failed: ${details}`);
    }
  }

  private async handlePlayCommand(
    message: Message,
    channel: GuildTextBasedChannel,
    rest: string,
  ): Promise<void> {
    if (!rest) {
      await sendWithRetry(channel, `Usage: ${this.config.prefix}play <url>`);
      return;
    }

    if (!message.member?.voice.channel) {
      await sendWithRetry(channel, "Join a voice channel first.");
      return;
    }

    const controller = this.getOrCreateGuildController(message.guild!);
    await controller.connect(message.member, channel);
    const entries = await fetchEntries(normalizeNiconicoUrl(rest), this.config);

    if (entries.length === 0) {
      await sendWithRetry(channel, "No tracks were found for that URL.");
      return;
    }

    controller.enqueueEntries(entries, message.member.displayName);

    if (entries.length > 1) {
      await sendWithRetry(channel, `Added ${entries.length} tracks to the queue.`);
    }

    await controller.playIfIdle();
  }

  private async handleTagCommand(
    message: Message,
    channel: GuildTextBasedChannel,
    rest: string,
  ): Promise<void> {
    if (!rest) {
      await sendWithRetry(channel, `Usage: ${this.config.prefix}tag <tag|url> [limit]`);
      return;
    }

    if (!message.member?.voice.channel) {
      await sendWithRetry(channel, "Join a voice channel first.");
      return;
    }

    const { tag, limit } = parseTagRequest(rest);

    if (!tag) {
      await sendWithRetry(channel, "A NicoNico tag is required.");
      return;
    }

    const controller = this.getOrCreateGuildController(message.guild!);
    await controller.connect(message.member, channel);
    await sendWithRetry(channel, `Searching NicoNico tag "${tag}" (limit ${limit})...`);
    const entries = await searchByTag(tag, limit);

    if (entries.length === 0) {
      await sendWithRetry(channel, "No tracks were found for that tag.");
      return;
    }

    controller.enqueueEntries(entries, message.member.displayName);
    await sendWithRetry(channel, `Added ${entries.length} tracks from tag "${tag}".`);
    await controller.playIfIdle();
  }

  private async handleSkipCommand(
    message: Message,
    channel: GuildTextBasedChannel,
  ): Promise<void> {
    const controller = this.guildControllers.get(message.guild!.id);

    if (!controller) {
      await sendWithRetry(channel, "Nothing is playing.");
      return;
    }

    const skipped = await controller.skip();

    if (!skipped) {
      await sendWithRetry(channel, "Nothing is playing.");
      return;
    }

    await sendWithRetry(channel, "Skipped the current track.");
  }

  private async handleQueueCommand(
    message: Message,
    channel: GuildTextBasedChannel,
  ): Promise<void> {
    const controller = this.guildControllers.get(message.guild!.id);

    if (!controller) {
      await sendWithRetry(channel, "Queue is empty.");
      return;
    }

    await sendWithRetry(channel, controller.describeQueue());
  }

  private async handleStopCommand(
    message: Message,
    channel: GuildTextBasedChannel,
  ): Promise<void> {
    const controller = this.guildControllers.get(message.guild!.id);

    if (!controller) {
      await sendWithRetry(channel, "Nothing is active in this guild.");
      return;
    }

    await controller.destroy();
    this.guildControllers.delete(message.guild!.id);
    await sendWithRetry(channel, "Stopped playback and left the voice channel.");
  }

  private async handleVolumeCommand(
    message: Message,
    channel: GuildTextBasedChannel,
    rest: string,
  ): Promise<void> {
    const controller = this.guildControllers.get(message.guild!.id);

    if (!rest) {
      const currentVolume = controller?.getVolumePercent() ?? 100;
      await sendWithRetry(channel, `Current volume: ${currentVolume}%`);
      return;
    }

    const parsed = Number.parseInt(rest, 10);

    if (Number.isNaN(parsed) || parsed < 0 || parsed > 300) {
      await sendWithRetry(channel, "Volume must be a number between 0 and 300.");
      return;
    }

    const activeController = controller ?? this.getOrCreateGuildController(message.guild!);
    const applied = await activeController.setVolume(parsed);
    await sendWithRetry(channel, `Volume set to ${applied}%.`);
  }

  private async handleMuteCommand(
    message: Message,
    channel: GuildTextBasedChannel,
  ): Promise<void> {
    const controller =
      this.guildControllers.get(message.guild!.id) ??
      this.getOrCreateGuildController(message.guild!);
    const currentVolume = await controller.toggleMute();

    if (currentVolume === 0) {
      await sendWithRetry(channel, "Muted.");
      return;
    }

    await sendWithRetry(channel, `Unmuted. Restored volume to ${currentVolume}%.`);
  }

  private async handleVoiceStateUpdate(
    _oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    const controller = this.guildControllers.get(newState.guild.id);

    if (!controller) {
      return;
    }

    const channelId = controller.getConnectionChannelId();

    if (!channelId) {
      return;
    }

    const channel = newState.guild.channels.cache.get(channelId);

    if (!channel?.isVoiceBased()) {
      return;
    }

    const humanMembers = channel.members.filter((member) => !member.user.bot);

    if (humanMembers.size > 0) {
      return;
    }

    this.log("info", `[${newState.guild.name}] Left voice channel because it became empty.`);
    await controller.destroy();
    this.guildControllers.delete(newState.guild.id);
  }

  private async waitForDiscordApi(): Promise<void> {
    const url = "https://discord.com/api/v10/users/@me";

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bot ${this.config.token}`,
          },
        });

        if (response.status !== 429) {
          return;
        }

        const waitTime = 60_000 * attempt;
        this.log("warn", `Discord API rate-limited the login probe, waiting ${waitTime / 1000}s.`);
        await sleep(waitTime);
      } catch (error) {
        this.log("warn", `Discord API probe failed: ${formatError(error)}`);
        return;
      }
    }
  }
}
