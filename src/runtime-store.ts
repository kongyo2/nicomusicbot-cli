import type {
  DashboardState,
  DependencyCheck,
  GuildSnapshot,
  LogEntry,
  LogLevel,
  ProgressState,
  RuntimeStatus,
} from "./types.js";

type Listener = () => void;

export class RuntimeStore {
  private listeners = new Set<Listener>();
  private logId = 0;
  private state: DashboardState;

  constructor(prefix: string, configPath: string) {
    this.state = {
      status: "idle",
      dependencies: [],
      guilds: [],
      logs: [],
      prefix,
      configPath,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): DashboardState {
    return this.state;
  }

  setStatus(status: RuntimeStatus, error?: string): void {
    this.state = {
      ...this.state,
      status,
      error,
    };
    this.emit();
  }

  setProgress(progress?: ProgressState): void {
    this.state = {
      ...this.state,
      progress,
    };
    this.emit();
  }

  setDependencies(dependencies: DependencyCheck[]): void {
    this.state = {
      ...this.state,
      dependencies,
    };
    this.emit();
  }

  setConnectedUser(connectedUser?: string): void {
    this.state = {
      ...this.state,
      connectedUser,
    };
    this.emit();
  }

  upsertGuild(snapshot: GuildSnapshot): void {
    const guilds = [...this.state.guilds];
    const index = guilds.findIndex((guild) => guild.guildId === snapshot.guildId);

    if (index === -1) {
      guilds.push(snapshot);
    } else {
      guilds[index] = snapshot;
    }

    guilds.sort((a, b) => a.guildName.localeCompare(b.guildName));

    this.state = {
      ...this.state,
      guilds,
    };
    this.emit();
  }

  removeGuild(guildId: string): void {
    this.state = {
      ...this.state,
      guilds: this.state.guilds.filter((guild) => guild.guildId !== guildId),
    };
    this.emit();
  }

  clearGuilds(): void {
    this.state = {
      ...this.state,
      guilds: [],
    };
    this.emit();
  }

  addLog(level: LogLevel, message: string): void {
    const entry: LogEntry = {
      id: ++this.logId,
      timestamp: new Date().toLocaleTimeString("ja-JP", {
        hour12: false,
      }),
      level,
      message,
    };

    this.state = {
      ...this.state,
      logs: [...this.state.logs.slice(-199), entry],
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
