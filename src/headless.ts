import {
  NicomusicBotService,
  autoSetupPrerequisites as defaultAutoSetupPrerequisites,
  checkPrerequisites as defaultCheckPrerequisites,
} from "./bot-service.js";
import {
  draftToConfig,
  getHelpText,
  loadInitialDraft,
  saveConfigToDisk,
  type CliOptions,
} from "./config.js";
import { RuntimeStore } from "./runtime-store.js";
import type {
  BotConfig,
  DependencyCheck,
  DependencySetupResult,
  LogEntry,
} from "./types.js";

type HeadlessService = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type ShutdownContext = {
  service: HeadlessService;
  store: RuntimeStore;
  config: BotConfig;
};

type HeadlessDependencies = {
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  checkPrerequisites?: () => Promise<DependencyCheck[]>;
  autoSetupPrerequisites?: (
    checks: DependencyCheck[],
  ) => Promise<DependencySetupResult>;
  createService?: (config: BotConfig, store: RuntimeStore) => HeadlessService;
  waitForShutdown?: (context: ShutdownContext) => Promise<void>;
};

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function safeWrite(stream: NodeJS.WriteStream, message: string): void {
  try {
    stream.write(message);
  } catch (error) {
    const normalized = normalizeError(error);

    if (!("code" in normalized) || normalized.code !== "EPIPE") {
      throw normalized;
    }
  }
}

function writeLine(stream: NodeJS.WriteStream, message = ""): void {
  safeWrite(stream, `${message}\n`);
}

function formatLog(entry: LogEntry): string {
  return `[${entry.level}] ${entry.message}`;
}

function attachLogSink(
  store: RuntimeStore,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): () => void {
  let lastLogId = 0;

  return store.subscribe(() => {
    const logs = store.getState().logs.filter((entry) => entry.id > lastLogId);

    for (const entry of logs) {
      lastLogId = entry.id;
      writeLine(
        entry.level === "error" || entry.level === "warn" ? stderr : stdout,
        formatLog(entry),
      );
    }
  });
}

async function waitForProcessShutdown({
  service,
}: ShutdownContext): Promise<void> {
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    const stop = () => {
      cleanup();
      resolve();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  await service.stop();
}

async function resolveDependencyChecks(
  checks: DependencyCheck[],
  checkPrerequisites: () => Promise<DependencyCheck[]>,
  autoSetupPrerequisites: (
    checks: DependencyCheck[],
  ) => Promise<DependencySetupResult>,
): Promise<DependencyCheck[]> {
  const missingRequired = checks.filter((check) => check.required && !check.ok);

  if (missingRequired.length === 0) {
    return checks;
  }

  const setup = await autoSetupPrerequisites(checks);

  if (!setup.attempted) {
    return checks;
  }

  return checkPrerequisites();
}

export async function runHeadless(
  options: CliOptions,
  dependencies: HeadlessDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const checkPrerequisites =
    dependencies.checkPrerequisites ?? defaultCheckPrerequisites;
  const autoSetupPrerequisites =
    dependencies.autoSetupPrerequisites ?? defaultAutoSetupPrerequisites;
  const createService =
    dependencies.createService ??
    ((config: BotConfig, store: RuntimeStore) =>
      new NicomusicBotService(config, store));
  const waitForShutdown =
    dependencies.waitForShutdown ?? waitForProcessShutdown;
  let service: HeadlessService | undefined;

  if (options.help) {
    writeLine(stdout, getHelpText());
    return 0;
  }

  const initial = await loadInitialDraft(options);

  for (const warning of initial.warnings) {
    writeLine(stderr, warning);
  }

  if (initial.validationIssues.length > 0) {
    writeLine(stderr, "Cannot start NicomusicBot in non-interactive mode.");

    for (const issue of initial.validationIssues) {
      writeLine(stderr, `- ${issue}`);
    }

    writeLine(stderr);
    writeLine(stderr, getHelpText());
    return 1;
  }

  const config = draftToConfig(initial.draft);
  const store = new RuntimeStore(config.prefix, config.configPath);
  const detachLogSink = attachLogSink(store, stdout, stderr);

  try {
    store.setStatus("starting");
    store.addLog("info", "Starting in non-interactive mode.");

    const checks = await resolveDependencyChecks(
      await checkPrerequisites(),
      checkPrerequisites,
      autoSetupPrerequisites,
    );
    store.setDependencies(checks);

    const missing = checks.filter((check) => check.required && !check.ok);

    if (missing.length > 0) {
      const message = `Missing dependencies: ${missing
        .map((check) => check.command)
        .join(", ")}`;

      store.setStatus("error", message);
      store.addLog("error", message);
      return 1;
    }

    if (initial.draft.saveConfig) {
      await saveConfigToDisk(config);
      store.addLog("success", `Saved config to ${config.configPath}.`);
    }

    service = createService(config, store);
    await service.start();
    writeLine(stdout, "NicomusicBot is running in non-interactive mode.");
    await waitForShutdown({ service, store, config });
    return 0;
  } catch (error) {
    const message = normalizeError(error).message;

    store.setStatus("error", message);
    store.addLog("error", message);
    await service?.stop().catch(() => undefined);
    return 1;
  } finally {
    detachLogSink();
  }
}
