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
};

type CliOptions = {
  help: boolean;
  autoStart: boolean;
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
});

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
    configPath: z.string().min(1),
  })
  .superRefine((value, ctx) => {
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

function buildCandidate(draft: ConfigDraft): BotConfig {
  return {
    token: draft.token,
    prefix: draft.prefix,
    niconicoUser: normalizeOptional(draft.niconicoUser),
    niconicoPassword: normalizeOptional(draft.niconicoPassword),
    configPath: draft.configPath,
  };
}

function resolveDefaultConfigPath(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ??
      path.join(os.homedir(), "AppData", "Roaming");

    return path.join(appData, "nicomusicbot", "config.json");
  }

  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");

  return path.join(xdgConfigHome, "nicomusicbot", "config.json");
}

export function parseCliOptions(argv: string[] = process.argv.slice(2)): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      token: { type: "string" },
      prefix: { type: "string" },
      config: { type: "string" },
      "skip-menu": { type: "boolean" },
      "save-config": { type: "boolean" },
      "no-save-config": { type: "boolean" },
      "niconico-user": { type: "string" },
      "niconico-password": { type: "string" },
    },
    allowPositionals: false,
  });

  const configPath = values.config
    ? path.resolve(values.config)
    : resolveDefaultConfigPath();
  const saveConfigOverride = values["save-config"]
    ? true
    : values["no-save-config"]
      ? false
      : undefined;

  return {
    help: Boolean(values.help),
    autoStart: Boolean(values["skip-menu"]),
    configPath,
    saveConfigOverride,
    savePreferenceLocked: saveConfigOverride !== undefined,
    overrides: {
      token: values.token,
      prefix: values.prefix,
      niconicoUser: values["niconico-user"],
      niconicoPassword: values["niconico-password"],
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
    ...loadEnvironmentConfig(),
    ...options.overrides,
  };

  const draft: ConfigDraft = {
    token: merged.token ?? "",
    prefix: merged.prefix ?? "!",
    niconicoUser: merged.niconicoUser ?? "",
    niconicoPassword: merged.niconicoPassword ?? "",
    saveConfig:
      options.saveConfigOverride ?? persisted.loaded,
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
  const defaultConfigPath = resolveDefaultConfigPath();

  return [
    "NicomusicBot",
    "",
    "Usage:",
    "  nicomusicbot [options]",
    "",
    "Options:",
    "  --token <token>                Discord bot token",
    "  --prefix <prefix>              Command prefix (default: !)",
    "  --niconico-user <value>        NicoNico login username/email",
    "  --niconico-password <value>    NicoNico login password",
    "  --config <path>                Config file path",
    "  --save-config                  Save config after setup",
    "  --no-save-config               Do not save config",
    "  --skip-menu                    Start immediately when config is valid",
    "  -h, --help                     Show help",
    "",
    `Default config path: ${defaultConfigPath}`,
  ].join("\n");
}
