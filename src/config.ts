import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { BotConfig, ConfigDraft } from "./types.js";

type PersistedConfig = {
  token?: string;
  prefix?: string;
  niconicoUser?: string;
  niconicoPassword?: string;
  niconicoSession?: string;
};

export type CliOptions = {
  help: boolean;
  autoStart: boolean;
  profile: string;
  configPath: string;
  saveConfigOverride?: boolean;
  savePreferenceLocked: boolean;
  overrides: Partial<PersistedConfig>;
};

type InitialDraftResult = {
  draft: ConfigDraft;
  validationIssues: string[];
  warnings: string[];
  loadedFromFile: boolean;
};

const persistedConfigSchema = z.object({
  token: z.string().optional(),
  prefix: z.string().optional(),
  niconicoUser: z.string().optional(),
  niconicoPassword: z.string().optional(),
  niconicoSession: z.string().optional(),
});

const defaultProfile = "default";

const botConfigSchema = z
  .object({
    token: z.string().trim().min(1, "Discord token is required."),
    prefix: z
      .string()
      .trim()
      .min(1, "Command prefix is required.")
      .max(10, "Command prefix must be 10 characters or fewer."),
    niconicoUser: z.string().trim().optional(),
    niconicoPassword: z.string().optional(),
    niconicoSession: z.string().trim().optional(),
    profile: z.string().trim().min(1, "Profile name is required."),
    configPath: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    // A session cookie is the preferred auth and takes precedence at runtime,
    // so a stale/partial username/password pair should not block startup.
    if (value.niconicoSession) {
      return;
    }

    const hasUser = Boolean(value.niconicoUser);
    const hasPassword = Boolean(value.niconicoPassword);

    if (hasUser !== hasPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "NicoNico login requires both username/email and password, or neither.",
        path: hasUser ? ["niconicoPassword"] : ["niconicoUser"],
      });
    }
  });

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeProfileName(value: string | undefined): string {
  const profile = value?.trim() || defaultProfile;

  if (profile === "." || profile === "..") {
    throw new TypeError("Profile name cannot be a relative path segment.");
  }

  if (/[\\/]/.test(profile)) {
    throw new TypeError("Profile name cannot contain path separators.");
  }

  for (const character of profile) {
    const code = character.charCodeAt(0);

    if (code < 32 || code === 127) {
      throw new TypeError("Profile name cannot contain control characters.");
    }
  }

  if (profile.length > 64) {
    throw new TypeError("Profile name must be 64 characters or fewer.");
  }

  return profile;
}

function profileFileName(profile: string): string {
  return `${encodeURIComponent(profile)}.json`;
}

function withoutUndefined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function buildCandidate(draft: ConfigDraft): BotConfig {
  return {
    profile: draft.profile,
    token: draft.token,
    prefix: draft.prefix,
    niconicoUser: normalizeOptional(draft.niconicoUser),
    niconicoPassword: normalizeOptional(draft.niconicoPassword),
    niconicoSession: normalizeOptional(draft.niconicoSession),
    configPath: draft.configPath,
  };
}

function resolveDefaultConfigPath(profile: string): string {
  const configFile =
    profile === defaultProfile
      ? "config.json"
      : path.join("profiles", profileFileName(profile));

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");

    return path.join(appData, "nicomusicbot", configFile);
  }

  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");

  return path.join(xdgConfigHome, "nicomusicbot", configFile);
}

export function parseCliOptions(
  argv: string[] = process.argv.slice(2),
): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      token: { type: "string" },
      prefix: { type: "string" },
      profile: { type: "string" },
      config: { type: "string" },
      "skip-menu": { type: "boolean" },
      "save-config": { type: "boolean" },
      "no-save-config": { type: "boolean" },
      "niconico-user": { type: "string" },
      "niconico-password": { type: "string" },
      "niconico-session": { type: "string" },
    },
    allowPositionals: false,
  });

  const profile = normalizeProfileName(
    values.profile ?? process.env.NICOMUSICBOT_PROFILE,
  );
  const configPath = values.config
    ? path.resolve(values.config)
    : resolveDefaultConfigPath(profile);
  const saveConfigOverride = values["save-config"]
    ? true
    : values["no-save-config"]
      ? false
      : undefined;

  return {
    help: Boolean(values.help),
    autoStart: Boolean(values["skip-menu"]),
    profile,
    configPath,
    saveConfigOverride,
    savePreferenceLocked: saveConfigOverride !== undefined,
    overrides: {
      token: values.token,
      prefix: values.prefix,
      niconicoUser: values["niconico-user"],
      niconicoPassword: values["niconico-password"],
      niconicoSession: values["niconico-session"],
    },
  };
}

async function loadPersistedConfig(configPath: string): Promise<{
  loaded: boolean;
  config: PersistedConfig;
  warning?: string;
}> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = persistedConfigSchema.safeParse(parsed);

    if (!result.success) {
      return {
        loaded: false,
        config: {},
        warning: `Ignored invalid config file: ${configPath}`,
      };
    }

    return {
      loaded: true,
      config: result.data,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("ENOENT")) {
      return { loaded: false, config: {} };
    }

    return {
      loaded: false,
      config: {},
      warning: `Could not read config file: ${message}`,
    };
  }
}

function loadEnvironmentConfig(): PersistedConfig {
  return {
    token: process.env.DISCORD_TOKEN,
    prefix: process.env.NICOMUSICBOT_PREFIX,
    niconicoUser: process.env.NICONICO_USER,
    niconicoPassword:
      process.env.NICONICO_PASS ?? process.env.NICONICO_PASSWORD,
    niconicoSession:
      process.env.NICONICO_SESSION ?? process.env.NICONICO_SESSION_COOKIE,
  };
}

export async function loadInitialDraft(
  options: CliOptions,
): Promise<InitialDraftResult> {
  const warnings: string[] = [];
  const persisted = await loadPersistedConfig(options.configPath);

  if (persisted.warning) {
    warnings.push(persisted.warning);
  }

  const merged = {
    prefix: "!",
    ...persisted.config,
    ...withoutUndefined(loadEnvironmentConfig()),
    ...withoutUndefined(options.overrides),
  };

  const draft: ConfigDraft = {
    profile: options.profile,
    token: merged.token ?? "",
    prefix: merged.prefix ?? "!",
    niconicoUser: merged.niconicoUser ?? "",
    niconicoPassword: merged.niconicoPassword ?? "",
    niconicoSession: merged.niconicoSession ?? "",
    saveConfig: options.saveConfigOverride ?? persisted.loaded,
    configPath: options.configPath,
  };

  return {
    draft,
    validationIssues: validateDraft(draft),
    warnings,
    loadedFromFile: persisted.loaded,
  };
}

export function validateDraft(draft: ConfigDraft): string[] {
  const result = botConfigSchema.safeParse(buildCandidate(draft));

  if (result.success) {
    return [];
  }

  return result.error.issues.map((issue) => issue.message);
}

export function draftToConfig(draft: ConfigDraft): BotConfig {
  return botConfigSchema.parse(buildCandidate(draft));
}

export async function saveConfigToDisk(config: BotConfig): Promise<void> {
  await mkdir(path.dirname(config.configPath), { recursive: true });

  const persisted: PersistedConfig = {
    token: config.token,
    prefix: config.prefix,
    niconicoUser: config.niconicoUser,
    niconicoPassword: config.niconicoPassword,
    niconicoSession: config.niconicoSession,
  };

  await writeFile(
    config.configPath,
    `${JSON.stringify(persisted, null, 2)}\n`,
    "utf8",
  );
}

export function maskSecret(value: string): string {
  if (!value.trim()) {
    return "not set";
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function getHelpText(): string {
  const defaultConfigPath = resolveDefaultConfigPath(defaultProfile);

  return [
    "NicomusicBot",
    "",
    "Usage:",
    "  nicomusicbot [options]",
    "",
    "Options:",
    "  --token <token>                Discord bot token",
    "  --prefix <prefix>              Command prefix (default: !)",
    "  --profile <name>               Config profile name (default: default)",
    "  --niconico-user <value>        NicoNico login username/email",
    "  --niconico-password <value>    NicoNico login password",
    "  --niconico-session <value>     NicoNico user_session cookie (recommended)",
    "  --config <path>                Config file path",
    "  --save-config                  Save config after setup",
    "  --no-save-config               Do not save config",
    "  --skip-menu                    Start immediately when config is valid",
    "  -h, --help                     Show help",
    "",
    `Default config path: ${defaultConfigPath}`,
  ].join("\n");
}
