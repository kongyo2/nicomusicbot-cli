#!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { getHelpText, loadInitialDraft, parseCliOptions } from "./config.js";

async function main(): Promise<void> {
  const options = parseCliOptions();

  if (options.help) {
    process.stdout.write(`${getHelpText()}\n`);
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
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
