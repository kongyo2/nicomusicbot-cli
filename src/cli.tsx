#!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { err, ok, type Result } from "neverthrow";
import { App } from "./app.js";
import { getHelpText, loadInitialDraft, parseCliOptions } from "./config.js";
import { normalizeError, normalizeErrorMessage } from "./errors.js";
import { runHeadless } from "./headless.js";
import { shouldUseHeadlessMode } from "./terminal.js";

function isEpipeError(error: Error): boolean {
  return "code" in error && error.code === "EPIPE";
}

function safeWrite(
  stream: NodeJS.WriteStream,
  message: string,
): Result<void, Error> {
  try {
    stream.write(message);
    return ok(undefined);
  } catch (error) {
    const normalized = normalizeError(error);

    if (isEpipeError(normalized)) {
      return ok(undefined);
    }

    return err(normalized);
  }
}

function bindProcessErrorGuards(): void {
  const swallowEpipe = (error: unknown) => {
    const normalized = normalizeError(error);

    if (isEpipeError(normalized)) {
      process.exitCode = 0;
      return;
    }

    safeWrite(process.stderr, `${normalized.message}\n`);
    process.exit(1);
  };

  process.stdout.on("error", swallowEpipe);
  process.stderr.on("error", swallowEpipe);
  process.on("uncaughtException", swallowEpipe);
  process.on("unhandledRejection", swallowEpipe);
}

async function main(): Promise<void> {
  bindProcessErrorGuards();
  const options = parseCliOptions();

  if (options.help) {
    safeWrite(process.stdout, `${getHelpText()}\n`);
    return;
  }

  if (shouldUseHeadlessMode(process.stdin, process.stdout)) {
    process.exitCode = await runHeadless(options);
    return;
  }

  const initial = await loadInitialDraft(options);
  const instance = render(
    <App
      autoStart={options.autoStart}
      initialDraft={initial.draft}
      initialValidationIssues={initial.validationIssues}
      loadedFromFile={initial.loadedFromFile}
      savePreferenceLocked={options.savePreferenceLocked}
      warnings={initial.warnings}
    />,
  );

  await instance.waitUntilExit();
}

main().catch((error) => {
  const message = normalizeErrorMessage(error);
  safeWrite(process.stderr, `${message}\n`);
  process.exitCode = 1;
});
