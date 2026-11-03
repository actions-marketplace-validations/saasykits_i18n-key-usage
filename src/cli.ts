#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkMessageUsage } from "./analyzer/check";
import { CONFIG_FILE, ConfigError, loadConfig } from "./config";
import {
  createReport,
  EReportFormat,
  formatGithub,
  formatJson,
  formatSummary,
  formatText,
  hasProblems,
} from "./report";

const HELP = `Usage: i18n-key-usage [options]

Finds unused, missing and unresolved message keys.

Options:
  -c, --config <file>   Config file (default: ${CONFIG_FILE})
  -r, --root <dir>      Project root (default: current directory)
  -f, --format <name>   text, json or github (default: text; github when GITHUB_ACTIONS is set)
      --progress        Print each scanned file to stderr
  -h, --help            Show this help

Exit codes: 0 clean, 1 problems found, 2 configuration or parse error.
`;

function main(): number {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c", default: CONFIG_FILE },
      root: { type: "string", short: "r", default: "." },
      format: { type: "string", short: "f" },
      progress: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const format = (values.format ??
    (process.env.GITHUB_ACTIONS === "true"
      ? EReportFormat.Github
      : EReportFormat.Text)) as EReportFormat;
  if (!Object.values(EReportFormat).includes(format)) {
    process.stderr.write(`Unknown format: ${format}\n`);
    return 2;
  }
  const { options, keyFiles } = loadConfig(resolve(values.root), values.config);
  const result = checkMessageUsage({
    ...options,
    onFile: values.progress
      ? (file, index) => process.stderr.write(`${index}: ${file}\n`)
      : undefined,
  });
  const report = createReport(result, keyFiles);
  const output =
    format === EReportFormat.Json
      ? formatJson(report)
      : format === EReportFormat.Github
        ? formatGithub(report)
        : formatText(report);
  process.stdout.write(output);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (format === EReportFormat.Github && summary) appendFileSync(summary, formatSummary(report));
  return hasProblems(report) ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `${error instanceof ConfigError ? error.message : ((error as Error).stack ?? String(error))}\n`,
  );
  process.exitCode = 2;
}
