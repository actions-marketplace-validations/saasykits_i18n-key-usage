#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkMessageUsage } from "./analyzer/check";
import { CONFIG_FILE, ConfigError, loadConfig } from "./config";
import { ENV_PREFIX, flagDefinitions, flagHelp, readOverrides } from "./overrides";
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
  -c, --config <file>   Config file (default: ${CONFIG_FILE}, optional)
  -r, --root <dir>      Project root (default: current directory)
  -f, --format <name>   text, json or github (default: text; github when GITHUB_ACTIONS is set)
      --progress        Print each scanned file to stderr
  -h, --help            Show this help

Config options (override the config file; list flags repeat or take comma-separated values):
${flagHelp()}

Every option also reads an environment variable: ${ENV_PREFIX}CONFIG, ${ENV_PREFIX}ROOT,
${ENV_PREFIX}FORMAT, ${ENV_PREFIX}MESSAGES, ${ENV_PREFIX}KEY_TYPES and so on. Flags win over
variables, and variables win over the config file.

Exit codes: 0 clean, 1 problems found, 2 configuration or parse error.
`;

function main(): number {
  const env = process.env;
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      root: { type: "string", short: "r" },
      format: { type: "string", short: "f" },
      progress: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      ...flagDefinitions(),
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const format = (values.format ??
    (env[`${ENV_PREFIX}FORMAT`] || undefined) ??
    (env.GITHUB_ACTIONS === "true" ? EReportFormat.Github : EReportFormat.Text)) as EReportFormat;
  if (!Object.values(EReportFormat).includes(format)) {
    process.stderr.write(`Unknown format: ${format}\n`);
    return 2;
  }
  const root = resolve(values.root ?? (env[`${ENV_PREFIX}ROOT`] || "."));
  const { options, keyFiles } = loadConfig(root, {
    file: values.config ?? (env[`${ENV_PREFIX}CONFIG`] || undefined),
    overrides: readOverrides(values, env),
  });
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
        ? formatGithub(report, repositoryPrefix(root))
        : formatText(report);
  process.stdout.write(output);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (format === EReportFormat.Github && summary) appendFileSync(summary, formatSummary(report));
  return hasProblems(report) ? 1 : 0;
}

/** The project root relative to the checked-out repository, for annotation paths. */
function repositoryPrefix(root: string): string {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) return "";
  const path = relative(resolve(workspace), root).replaceAll("\\", "/");
  return path.startsWith("..") ? "" : path;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `${error instanceof ConfigError ? error.message : ((error as Error).stack ?? String(error))}\n`,
  );
  process.exitCode = 2;
}
