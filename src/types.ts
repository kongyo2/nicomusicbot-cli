export type LogLevel = "info" | "warn" | "error" | "success";

export type RuntimeStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export type GuildPlaybackStatus = "idle" | "connecting" | "playing" | "error";

export type DependencyCheck = {
  name: string;
  command: string;
  ok: boolean;
  details: string;
};

export type ProgressState = {
  label: string;
  value: number;
};

export type TrackEntry = {
  id?: string;
  title?: string;
  url?: string;
  webpageUrl?: string;
  requestedBy?: string;
};

export type GuildSnapshot = {
  guildId: string;
  guildName: string;
  voiceChannelName?: string;
  textChannelName?: string;
  queueLength: number;
  currentTitle?: string;
  currentUrl?: string;
  volume: number;
  muted: boolean;
  state: GuildPlaybackStatus;
  requestedBy?: string;
  lastError?: string;
};

export type LogEntry = {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
};

export type ConfigDraft = {
  token: string;
  prefix: string;
  niconicoUser: string;
  niconicoPassword: string;
  saveConfig: boolean;
  configPath: string;
};

export type BotConfig = {
  token: string;
  prefix: string;
  niconicoUser?: string;
  niconicoPassword?: string;
  configPath: string;
};

export type DashboardState = {
  status: RuntimeStatus;
  connectedUser?: string;
  progress?: ProgressState;
  dependencies: DependencyCheck[];
  guilds: GuildSnapshot[];
  logs: LogEntry[];
  error?: string;
  prefix: string;
  configPath: string;
};
