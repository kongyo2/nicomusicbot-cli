import React, {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  Alert,
  Badge,
  ConfirmInput,
  OrderedList,
  PasswordInput,
  ProgressBar,
  Select,
  Spinner,
  StatusMessage,
  TextInput,
  UnorderedList,
} from "@inkjs/ui";
import {
  draftToConfig,
  maskSecret,
  saveConfigToDisk,
  validateDraft,
} from "./config.js";
import { NicomusicBotService, checkPrerequisites } from "./bot-service.js";
import { RuntimeStore } from "./runtime-store.js";
import type {
  ConfigDraft,
  DashboardState,
  DependencyCheck,
  LogEntry,
} from "./types.js";

type Stage =
  | "overview"
  | "token"
  | "prefix"
  | "niconicoUser"
  | "niconicoPassword"
  | "save"
  | "starting"
  | "running"
  | "failed"
  | "stopping";

type AppProps = {
  autoStart: boolean;
  initialDraft: ConfigDraft;
  initialValidationIssues: string[];
  loadedFromFile: boolean;
  savePreferenceLocked: boolean;
  warnings: string[];
};

type AppState = {
  draft: ConfigDraft;
  validationIssues: string[];
  stage: Stage;
  store: RuntimeStore | null;
  startupError?: string;
  dependencyChecks: DependencyCheck[];
  selectedGuildId?: string;
};

type AppAction =
  | { type: "commitDraft"; draft: ConfigDraft }
  | { type: "setStage"; stage: Stage }
  | { type: "selectGuild"; guildId?: string }
  | { type: "startupBegin"; store: RuntimeStore }
  | { type: "setDependencyChecks"; dependencyChecks: DependencyCheck[] }
  | { type: "validationFailed"; issues: string[]; stage: Stage }
  | { type: "startupFailed"; message: string }
  | { type: "startupSucceeded" };

type HeaderProps = {
  draft: ConfigDraft;
  loadedFromFile: boolean;
  warnings: string[];
};

type ScreenHandlers = {
  commitDraft: (draft: ConfigDraft) => void;
  failValidation: (issues: string[], stage: Stage) => void;
  goToStage: (stage: Stage) => void;
  goToPostEditStage: (draft: ConfigDraft) => void;
};

function getInitialStage(
  autoStart: boolean,
  draft: ConfigDraft,
  validationIssues: string[],
): Stage {
  if (autoStart && validationIssues.length === 0) {
    return "starting";
  }

  if (validationIssues.length === 0) {
    return "overview";
  }

  return getFirstEditStage(draft);
}

function getFirstEditStage(draft: ConfigDraft): Stage {
  if (!draft.token.trim()) {
    return "token";
  }

  if (!draft.prefix.trim()) {
    return "prefix";
  }

  if (draft.niconicoUser.trim() && !draft.niconicoPassword.trim()) {
    return "niconicoPassword";
  }

  if (draft.niconicoPassword.trim() && !draft.niconicoUser.trim()) {
    return "niconicoUser";
  }

  return "token";
}

function createInitialAppState({
  autoStart,
  initialDraft,
  initialValidationIssues,
}: Pick<AppProps, "autoStart" | "initialDraft" | "initialValidationIssues">): AppState {
  return {
    draft: initialDraft,
    validationIssues: initialValidationIssues,
    stage: getInitialStage(autoStart, initialDraft, initialValidationIssues),
    store: null,
    startupError: undefined,
    dependencyChecks: [],
    selectedGuildId: undefined,
  };
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "commitDraft":
      return {
        ...state,
        draft: action.draft,
        validationIssues: validateDraft(action.draft),
      };
    case "setStage":
      return {
        ...state,
        stage: action.stage,
      };
    case "selectGuild":
      return {
        ...state,
        selectedGuildId: action.guildId,
      };
    case "startupBegin":
      return {
        ...state,
        stage: "starting",
        store: action.store,
        startupError: undefined,
        dependencyChecks: [],
      };
    case "setDependencyChecks":
      return {
        ...state,
        dependencyChecks: action.dependencyChecks,
      };
    case "validationFailed":
      return {
        ...state,
        validationIssues: action.issues,
        stage: action.stage,
      };
    case "startupFailed":
      return {
        ...state,
        startupError: action.message,
        stage: "failed",
      };
    case "startupSucceeded":
      return {
        ...state,
        stage: "running",
      };
    default:
      return state;
  }
}

function levelColor(level: LogEntry["level"]): string {
  switch (level) {
    case "success":
      return "green";
    case "warn":
      return "yellow";
    case "error":
      return "red";
    default:
      return "blue";
  }
}

function statusBadgeColor(status: DashboardState["status"]): string {
  switch (status) {
    case "running":
      return "green";
    case "error":
      return "red";
    case "stopping":
      return "yellow";
    case "stopped":
      return "blue";
    default:
      return "yellow";
  }
}

function runtimeVariant(
  status: DashboardState["status"],
): "info" | "success" | "error" | "warning" {
  switch (status) {
    case "running":
      return "success";
    case "error":
      return "error";
    case "stopping":
      return "warning";
    default:
      return "info";
  }
}

function useStoreState(store: RuntimeStore | null): DashboardState | null {
  return useSyncExternalStore(
    store ? store.subscribe.bind(store) : () => () => undefined,
    () => (store ? store.getState() : null),
    () => null,
  );
}

export function App({
  autoStart,
  initialDraft,
  initialValidationIssues,
  loadedFromFile,
  savePreferenceLocked,
  warnings,
}: AppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(
    appReducer,
    {
      autoStart,
      initialDraft,
      initialValidationIssues,
    },
    createInitialAppState,
  );
  const serviceRef = useRef<NicomusicBotService | null>(null);
  const stopRequestedRef = useRef(false);
  const runtimeState = useStoreState(state.store);
  const headerProps = {
    draft: state.draft,
    loadedFromFile,
    warnings,
  } satisfies HeaderProps;

  const selectedGuild = useMemo(() => {
    if (!runtimeState?.guilds.length) {
      return undefined;
    }

    return (
      runtimeState.guilds.find((guild) => guild.guildId === state.selectedGuildId) ??
      runtimeState.guilds[0]
    );
  }, [runtimeState, state.selectedGuildId]);

  useEffect(() => {
    if (
      !selectedGuild &&
      runtimeState?.guilds[0] &&
      state.selectedGuildId !== runtimeState.guilds[0].guildId
    ) {
      dispatch({
        type: "selectGuild",
        guildId: runtimeState.guilds[0].guildId,
      });
    }
  }, [runtimeState, selectedGuild, state.selectedGuildId]);

  useEffect(() => {
    return () => {
      void serviceRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (state.stage !== "starting") {
      return;
    }

    let cancelled = false;
    const nextStore = new RuntimeStore(
      state.draft.prefix || "!",
      state.draft.configPath,
    );

    dispatch({
      type: "startupBegin",
      store: nextStore,
    });

    const run = async () => {
      const issues = validateDraft(state.draft);

      if (issues.length > 0) {
        if (cancelled) {
          return;
        }

        dispatch({
          type: "validationFailed",
          issues,
          stage: getFirstEditStage(state.draft),
        });
        return;
      }

      nextStore.setStatus("starting");
      nextStore.setProgress({
        label: "Checking external dependencies",
        value: 20,
      });
      nextStore.addLog("info", "Checking yt-dlp and ffmpeg...");

      const checks = await checkPrerequisites();

      if (cancelled) {
        return;
      }

      dispatch({
        type: "setDependencyChecks",
        dependencyChecks: checks,
      });
      nextStore.setDependencies(checks);

      const missing = checks.filter((check) => !check.ok);

      if (missing.length > 0) {
        const message = `Missing dependencies: ${missing
          .map((check) => check.command)
          .join(", ")}`;

        nextStore.setStatus("error", message);
        nextStore.setProgress(undefined);
        nextStore.addLog("error", message);
        dispatch({
          type: "startupFailed",
          message,
        });
        return;
      }

      const config = draftToConfig(state.draft);

      if (state.draft.saveConfig) {
        nextStore.setProgress({
          label: "Saving config file",
          value: 40,
        });
        await saveConfigToDisk(config);
        nextStore.addLog("success", `Saved config to ${config.configPath}.`);
      } else {
        nextStore.addLog("info", "Running without saving config to disk.");
      }

      if (cancelled) {
        return;
      }

      const nextService = new NicomusicBotService(config, nextStore);
      await nextService.start();

      if (cancelled) {
        await nextService.stop().catch(() => undefined);
        return;
      }

      serviceRef.current = nextService;
      dispatch({
        type: "startupSucceeded",
      });
    };

    run().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);

      nextStore.setStatus("error", message);
      nextStore.setProgress(undefined);
      nextStore.addLog("error", message);
      dispatch({
        type: "startupFailed",
        message,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [state.draft, state.stage]);

  useInput((input, key) => {
    if (
      (state.stage === "running" ||
        state.stage === "overview" ||
        state.stage === "failed") &&
      (input === "q" || key.escape)
    ) {
      void requestExit();
    }
  });

  const handlers: ScreenHandlers = {
    commitDraft: (draft) => {
      dispatch({
        type: "commitDraft",
        draft,
      });
    },
    failValidation: (issues, stage) => {
      dispatch({
        type: "validationFailed",
        issues,
        stage,
      });
    },
    goToStage: (stage) => {
      dispatch({
        type: "setStage",
        stage,
      });
    },
    goToPostEditStage: (draft) => {
      dispatch({
        type: "commitDraft",
        draft,
      });
      dispatch({
        type: "setStage",
        stage: savePreferenceLocked ? "overview" : "save",
      });
    },
  };

  const requestExit = async () => {
    if (stopRequestedRef.current) {
      return;
    }

    stopRequestedRef.current = true;
    dispatch({
      type: "setStage",
      stage: "stopping",
    });
    await serviceRef.current?.stop().catch(() => undefined);
    serviceRef.current = null;
    exit();
  };

  switch (state.stage) {
    case "token":
      return (
        <TokenScreen
          headerProps={headerProps}
          draft={state.draft}
          validationIssues={state.validationIssues}
          handlers={handlers}
        />
      );
    case "prefix":
      return (
        <PrefixScreen
          headerProps={headerProps}
          draft={state.draft}
          validationIssues={state.validationIssues}
          handlers={handlers}
        />
      );
    case "niconicoUser":
      return (
        <NiconicoUserScreen
          headerProps={headerProps}
          draft={state.draft}
          validationIssues={state.validationIssues}
          handlers={handlers}
        />
      );
    case "niconicoPassword":
      return (
        <NiconicoPasswordScreen
          headerProps={headerProps}
          draft={state.draft}
          validationIssues={state.validationIssues}
          handlers={handlers}
        />
      );
    case "save":
      return (
        <SaveScreen
          headerProps={headerProps}
          draft={state.draft}
          handlers={handlers}
        />
      );
    case "starting":
      return (
        <StartingScreen
          headerProps={headerProps}
          progress={runtimeState?.progress}
          dependencyChecks={state.dependencyChecks}
        />
      );
    case "failed":
      return (
        <FailedScreen
          headerProps={headerProps}
          startupError={state.startupError}
          dependencyChecks={state.dependencyChecks}
          onRetry={() => {
            handlers.goToStage("starting");
          }}
          onEdit={() => {
            handlers.goToStage(getFirstEditStage(state.draft));
          }}
        />
      );
    case "running":
      return runtimeState ? (
        <RunningScreen
          headerProps={headerProps}
          draft={state.draft}
          runtimeState={runtimeState}
          selectedGuildId={state.selectedGuildId}
          onSelectGuild={(guildId) => {
            dispatch({
              type: "selectGuild",
              guildId,
            });
          }}
        />
      ) : null;
    case "stopping":
      return (
        <Box flexDirection="column" gap={1}>
          <Spinner label="Stopping NicomusicBot..." />
        </Box>
      );
    case "overview":
    default:
      return (
        <OverviewScreen
          headerProps={headerProps}
          draft={state.draft}
          onStart={() => {
            handlers.goToStage("starting");
          }}
          onEdit={() => {
            handlers.goToStage("token");
          }}
        />
      );
  }
}

function TokenScreen({
  headerProps,
  draft,
  validationIssues,
  handlers,
}: {
  headerProps: HeaderProps;
  draft: ConfigDraft;
  validationIssues: string[];
  handlers: ScreenHandlers;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Header {...headerProps} />
      <Text bold>Discord bot token</Text>
      <Text dimColor>
        {draft.token
          ? `Current token: ${maskSecret(draft.token)}`
          : "No token configured yet."}
      </Text>
      <PasswordInput
        placeholder={
          draft.token
            ? "Press Enter to keep the current token"
            : "Paste Discord bot token"
        }
        onSubmit={(value) => {
          const nextToken = value.trim() || draft.token;

          if (!nextToken.trim()) {
            handlers.failValidation(["Discord token is required."], "token");
            return;
          }

          handlers.commitDraft({
            ...draft,
            token: nextToken,
          });
          handlers.goToStage("prefix");
        }}
      />
      <ValidationMessages issues={validationIssues} />
    </Box>
  );
}

function PrefixScreen({
  headerProps,
  draft,
  validationIssues,
  handlers,
}: {
  headerProps: HeaderProps;
  draft: ConfigDraft;
  validationIssues: string[];
  handlers: ScreenHandlers;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Header {...headerProps} />
      <Text bold>Command prefix</Text>
      <Text dimColor>Examples: `!`, `?`, `!!`</Text>
      <TextInput
        placeholder="!"
        defaultValue={draft.prefix}
        onSubmit={(value) => {
          const nextPrefix = value.trim();

          if (!nextPrefix) {
            handlers.failValidation(["Command prefix is required."], "prefix");
            return;
          }

          handlers.commitDraft({
            ...draft,
            prefix: nextPrefix,
          });
          handlers.goToStage("niconicoUser");
        }}
      />
      <ValidationMessages issues={validationIssues} />
    </Box>
  );
}

function NiconicoUserScreen({
  headerProps,
  draft,
  validationIssues,
  handlers,
}: {
  headerProps: HeaderProps;
  draft: ConfigDraft;
  validationIssues: string[];
  handlers: ScreenHandlers;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Header {...headerProps} />
      <Text bold>NicoNico username or email</Text>
      <Text dimColor>Leave empty to run without NicoNico account credentials.</Text>
      <TextInput
        placeholder="Optional"
        defaultValue={draft.niconicoUser}
        onSubmit={(value) => {
          const nextUser = value.trim();

          if (!nextUser) {
            handlers.goToPostEditStage({
              ...draft,
              niconicoUser: "",
              niconicoPassword: "",
            });
            return;
          }

          handlers.commitDraft({
            ...draft,
            niconicoUser: nextUser,
          });
          handlers.goToStage("niconicoPassword");
        }}
      />
      <ValidationMessages issues={validationIssues} />
    </Box>
  );
}

function NiconicoPasswordScreen({
  headerProps,
  draft,
  validationIssues,
  handlers,
}: {
  headerProps: HeaderProps;
  draft: ConfigDraft;
  validationIssues: string[];
  handlers: ScreenHandlers;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Header {...headerProps} />
      <Text bold>NicoNico password</Text>
      <Text dimColor>
        {draft.niconicoPassword
          ? "Press Enter to keep the current password."
          : "Required only when using a NicoNico account."}
      </Text>
      <PasswordInput
        placeholder={
          draft.niconicoPassword
            ? "Press Enter to keep the current password"
            : "Enter NicoNico password"
        }
        onSubmit={(value) => {
          const nextPassword = value || draft.niconicoPassword;

          if (!nextPassword.trim()) {
            handlers.failValidation(
              ["NicoNico password is required when a NicoNico user is set."],
              "niconicoPassword",
            );
            return;
          }

          handlers.goToPostEditStage({
            ...draft,
            niconicoPassword: nextPassword,
          });
        }}
      />
      <ValidationMessages issues={validationIssues} />
    </Box>
  );
}

function SaveScreen({
  headerProps,
  draft,
  handlers,
}: {
  headerProps: HeaderProps;
  draft: ConfigDraft;
  handlers: ScreenHandlers;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Header {...headerProps} />
      <Text bold>Save config to disk?</Text>
      <Text dimColor>{draft.configPath}</Text>
      <Alert variant="warning" title="Plaintext secrets">
        Discord and NicoNico credentials are stored as plaintext JSON.
      </Alert>
      <ConfirmInput
        onConfirm={() => {
          handlers.commitDraft({
            ...draft,
            saveConfig: true,
          });
          handlers.goToStage("overview");
        }}
        onCancel={() => {
          handlers.commitDraft({
            ...draft,
            saveConfig: false,
          });
          handlers.goToStage("overview");
        }}
      />
    </Box>
  );
}

function StartingScreen({
  headerProps,
  progress,
  dependencyChecks,
}: {
  headerProps: HeaderProps;
  progress?: DashboardState["progress"];
  dependencyChecks: DependencyCheck[];
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Header {...headerProps} />
      <Spinner label={progress?.label ?? "Starting NicomusicBot..."} />
      <Box width={50}>
        <ProgressBar value={progress?.value ?? 0} />
      </Box>
      {dependencyChecks.length > 0 && (
        <DependencyList dependencyChecks={dependencyChecks} />
      )}
    </Box>
  );
}

function FailedScreen({
  headerProps,
  startupError,
  dependencyChecks,
  onRetry,
  onEdit,
}: {
  headerProps: HeaderProps;
  startupError?: string;
  dependencyChecks: DependencyCheck[];
  onRetry: () => void;
  onEdit: () => void;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Header {...headerProps} />
      <Alert variant="error" title="Startup failed">
        {startupError ?? "Unknown startup error."}
      </Alert>
      {dependencyChecks.length > 0 && (
        <DependencyList dependencyChecks={dependencyChecks} />
      )}
      <Text dimColor>Press `q` to quit, or answer below to continue.</Text>
      <ConfirmInput onConfirm={onRetry} onCancel={onEdit} />
    </Box>
  );
}

function RunningScreen({
  headerProps,
  draft,
  runtimeState,
  selectedGuildId,
  onSelectGuild,
}: {
  headerProps: HeaderProps;
  draft: ConfigDraft;
  runtimeState: DashboardState;
  selectedGuildId?: string;
  onSelectGuild: (guildId: string) => void;
}) {
  const selectedGuild =
    runtimeState.guilds.find((guild) => guild.guildId === selectedGuildId) ??
    runtimeState.guilds[0];

  return (
    <Box flexDirection="column" gap={1}>
      <Header {...headerProps} />
      <Box gap={1}>
        <Badge color={statusBadgeColor(runtimeState.status)}>
          {runtimeState.status.toUpperCase()}
        </Badge>
        <Badge color="blue">{runtimeState.connectedUser ?? "Connecting..."}</Badge>
        <Badge color="yellow">Prefix {draft.prefix}</Badge>
      </Box>
      <StatusMessage variant={runtimeVariant(runtimeState.status)}>
        Ready for `{draft.prefix}play`, `{draft.prefix}tag`, `{draft.prefix}skip`,
        `{draft.prefix}queue`, `{draft.prefix}stop`, `{draft.prefix}volume`,
        `{draft.prefix}mute`. Press `q` to quit.
      </StatusMessage>
      <Box gap={3}>
        <Box flexDirection="column" width={36} gap={1}>
          <Text bold>Guilds</Text>
          {runtimeState.guilds.length === 0 ? (
            <Spinner label="Waiting for commands from Discord..." />
          ) : (
            <Select
              key={`${runtimeState.guilds.map((guild) => guild.guildId).join("|")}:${selectedGuild?.guildId ?? "none"}`}
              defaultValue={selectedGuild?.guildId}
              options={runtimeState.guilds.map((guild) => ({
                label: `${guild.guildName} (${guild.queueLength})`,
                value: guild.guildId,
              }))}
              onChange={onSelectGuild}
            />
          )}
        </Box>
        <Box flexDirection="column" flexGrow={1} gap={1}>
          <Text bold>Selected guild</Text>
          {selectedGuild ? (
            <>
              <Box gap={1}>
                <Badge color="green">{selectedGuild.state}</Badge>
                <Badge color={selectedGuild.muted ? "red" : "blue"}>
                  {selectedGuild.volume}%
                </Badge>
                {selectedGuild.voiceChannelName && (
                  <Badge color="yellow">{selectedGuild.voiceChannelName}</Badge>
                )}
              </Box>
              <UnorderedList>
                <UnorderedList.Item>
                  <Text>Current: {selectedGuild.currentTitle ?? "Nothing playing"}</Text>
                </UnorderedList.Item>
                <UnorderedList.Item>
                  <Text>Queue length: {selectedGuild.queueLength}</Text>
                </UnorderedList.Item>
                <UnorderedList.Item>
                  <Text>Requested by: {selectedGuild.requestedBy ?? "Unknown"}</Text>
                </UnorderedList.Item>
                <UnorderedList.Item>
                  <Text>
                    Text channel: {selectedGuild.textChannelName ?? "Unknown"}
                  </Text>
                </UnorderedList.Item>
              </UnorderedList>
              {selectedGuild.currentUrl && (
                <Text dimColor>{selectedGuild.currentUrl}</Text>
              )}
              {selectedGuild.lastError && (
                <Alert variant="warning" title="Latest error">
                  {selectedGuild.lastError}
                </Alert>
              )}
            </>
          ) : (
            <StatusMessage variant="info">
              No guild has active state yet.
            </StatusMessage>
          )}
        </Box>
      </Box>
      <Box flexDirection="column" gap={1}>
        <Text bold>Recent logs</Text>
        {runtimeState.logs.length === 0 ? (
          <Text dimColor>No logs yet.</Text>
        ) : (
          <UnorderedList>
            {runtimeState.logs.slice(-8).map((entry) => (
              <UnorderedList.Item key={entry.id}>
                <Text color={levelColor(entry.level)}>
                  [{entry.timestamp}] {entry.message}
                </Text>
              </UnorderedList.Item>
            ))}
          </UnorderedList>
        )}
      </Box>
    </Box>
  );
}

function OverviewScreen({
  headerProps,
  draft,
  onStart,
  onEdit,
}: {
  headerProps: HeaderProps;
  draft: ConfigDraft;
  onStart: () => void;
  onEdit: () => void;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Header {...headerProps} />
      <StatusMessage variant="info">
        Review the current configuration and choose whether to start or edit it.
      </StatusMessage>
      {draft.saveConfig && (
        <Alert variant="warning" title="Plaintext secrets">
          Credentials will be stored as plaintext in the config file.
        </Alert>
      )}
      <ConfigSummary draft={draft} />
      <OrderedList>
        <OrderedList.Item>
          <Text>Invite the bot to a server with message and voice permissions.</Text>
        </OrderedList.Item>
        <OrderedList.Item>
          <Text>Join a voice channel in Discord.</Text>
        </OrderedList.Item>
        <OrderedList.Item>
          <Text>
            Run {`"${draft.prefix}play <nico url>"`} or {`"${draft.prefix}tag <tag> [limit]"`}.
          </Text>
        </OrderedList.Item>
      </OrderedList>
      <ConfirmInput onConfirm={onStart} onCancel={onEdit} />
      <Text dimColor>Press `q` to quit.</Text>
    </Box>
  );
}

function Header({ draft, loadedFromFile, warnings }: HeaderProps) {
  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Text bold>NicomusicBot</Text>
        <Badge color="blue">@kongyo2/nicomusicbot</Badge>
        <Badge color={loadedFromFile ? "green" : "yellow"}>
          {loadedFromFile ? "config loaded" : "session setup"}
        </Badge>
      </Box>
      <Text dimColor>Config path: {draft.configPath}</Text>
      {warnings.map((warning) => (
        <Alert key={warning} variant="warning">
          {warning}
        </Alert>
      ))}
    </Box>
  );
}

function ConfigSummary({ draft }: { draft: ConfigDraft }) {
  return (
    <UnorderedList>
      <UnorderedList.Item>
        <Text>Discord token: {maskSecret(draft.token)}</Text>
      </UnorderedList.Item>
      <UnorderedList.Item>
        <Text>Prefix: {draft.prefix || "(unset)"}</Text>
      </UnorderedList.Item>
      <UnorderedList.Item>
        <Text>
          NicoNico auth:{" "}
          {draft.niconicoUser ? `${draft.niconicoUser} + password` : "disabled"}
        </Text>
      </UnorderedList.Item>
      <UnorderedList.Item>
        <Text>Save config: {draft.saveConfig ? "yes" : "no"}</Text>
      </UnorderedList.Item>
    </UnorderedList>
  );
}

function ValidationMessages({ issues }: { issues: string[] }) {
  if (issues.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" gap={1}>
      {issues.map((issue) => (
        <StatusMessage key={issue} variant="warning">
          {issue}
        </StatusMessage>
      ))}
    </Box>
  );
}

function DependencyList({
  dependencyChecks,
}: {
  dependencyChecks: DependencyCheck[];
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Dependencies</Text>
      <UnorderedList>
        {dependencyChecks.map((check) => (
          <UnorderedList.Item key={check.command}>
            <Text color={check.ok ? "green" : "red"}>
              {check.command}: {check.details}
            </Text>
          </UnorderedList.Item>
        ))}
      </UnorderedList>
    </Box>
  );
}
