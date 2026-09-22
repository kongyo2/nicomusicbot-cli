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
    this.patch({ status, error });
  }

  setProgress(progress?: ProgressState): void {
    this.patch({ progress });
  }

  setDependencies(dependencies: DependencyCheck[]): void {
    this.patch({ dependencies });
  }

  setConnectedUser(connectedUser?: string): void {
    this.patch({ connectedUser });
  }

  upsertGuild(snapshot: GuildSnapshot): void {
    const guilds = [...this.state.guilds];
    const index = guilds.findIndex(
      (guild) => guild.guildId === snapshot.guildId,
    );

    if (index === -1) {
      guilds.push(snapshot);
    } else {
      guilds[index] = snapshot;
    }

    guilds.sort((a, b) => a.guildName.localeCompare(b.guildName));

    this.patch({ guilds });
  }

  removeGuild(guildId: string): void {
    this.patch({
      guilds: this.state.guilds.filter((guild) => guild.guildId !== guildId),
    });
  }

  clearGuilds(): void {
    this.patch({ guilds: [] });
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

    this.patch({ logs: [...this.state.logs.slice(-199), entry] });
  }

  private patch(changes: Partial<DashboardState>): void {
    this.state = {
      ...this.state,
      ...changes,
    };

    for (const listener of this.listeners) {
      listener();
    }
  }
}
