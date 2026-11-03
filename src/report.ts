import type { IUsageDiagnostic, IUsageResult } from "./analyzer/types";

export enum EReportFormat {
  Text = "text",
  Json = "json",
  Github = "github",
}

export interface IReport {
  unused: { key: string; file: string | undefined }[];
  missing: IUsageDiagnostic[];
  unresolved: IUsageDiagnostic[];
  invalidDeclarations: string[];
  files: number;
  keys: number;
  used: number;
}

export function createReport(result: IUsageResult, keyFiles: Map<string, string>): IReport {
  const byLocation = (left: IUsageDiagnostic, right: IUsageDiagnostic) =>
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.expression.localeCompare(right.expression);
  return {
    unused: result.unused.map((key) => ({ key, file: keyFiles.get(key) })),
    missing: [...result.missing].sort(byLocation),
    unresolved: [...result.unresolved].sort(byLocation),
    invalidDeclarations: [...result.invalidDeclarations].sort(),
    files: result.files,
    keys: keyFiles.size,
    used: result.used.size,
  };
}

export function hasProblems(report: IReport): boolean {
  return Boolean(
    report.unused.length ||
      report.missing.length ||
      report.unresolved.length ||
      report.invalidDeclarations.length,
  );
}

export function summaryLine(report: IReport): string {
  return `Scanned ${report.files} files: ${report.used}/${report.keys} keys referenced, ${report.unused.length} unused, ${report.missing.length} missing, ${report.unresolved.length} unresolved.`;
}

export function formatText(report: IReport): string {
  const lines: string[] = [];
  for (const { key, file } of report.unused)
    lines.push(`Unused message: ${key}${file ? ` (${file})` : ""}`);
  for (const diagnostic of [...report.missing, ...report.unresolved])
    lines.push(
      `${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}`,
      `  ${diagnostic.expression}`,
    );
  lines.push(...report.invalidDeclarations, summaryLine(report));
  return `${lines.join("\n")}\n`;
}

export function formatJson(report: IReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Workflow commands that show up as annotations on the pull request diff. */
export function formatGithub(report: IReport): string {
  const lines: string[] = [];
  for (const { key, file } of report.unused)
    lines.push(command("error", `Unused message key: ${key}`, file ? { file } : {}));
  for (const diagnostic of [...report.missing, ...report.unresolved])
    lines.push(
      command("error", `${diagnostic.message}: ${diagnostic.expression}`, {
        file: diagnostic.file,
        line: String(diagnostic.line),
      }),
    );
  for (const message of report.invalidDeclarations) lines.push(command("error", message, {}));
  lines.push(summaryLine(report));
  return `${lines.join("\n")}\n`;
}

/** Markdown for `$GITHUB_STEP_SUMMARY`. */
export function formatSummary(report: IReport): string {
  const lines = [
    "## i18n key usage",
    "",
    summaryLine(report),
    "",
    "| | Count |",
    "| --- | ---: |",
    `| Unused keys | ${report.unused.length} |`,
    `| Missing keys | ${report.missing.length} |`,
    `| Unresolved dynamic keys | ${report.unresolved.length} |`,
    `| Invalid declarations | ${report.invalidDeclarations.length} |`,
  ];
  const details = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push("", `<details><summary>${title} (${items.length})</summary>`, "");
    for (const item of items.slice(0, 200)) lines.push(`- ${item}`);
    if (items.length > 200) lines.push(`- … ${items.length - 200} more`);
    lines.push("", "</details>");
  };
  details(
    "Unused keys",
    report.unused.map(({ key }) => `\`${key}\``),
  );
  details(
    "Missing and unresolved",
    [...report.missing, ...report.unresolved].map(
      (item) => `\`${item.file}:${item.line}\` ${item.message}`,
    ),
  );
  details("Invalid declarations", report.invalidDeclarations);
  return `${lines.join("\n")}\n`;
}

function command(
  level: "error" | "warning",
  message: string,
  properties: Record<string, string>,
): string {
  const escapeData = (text: string) =>
    text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  const escapeProperty = (text: string) =>
    escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
  const props = Object.entries({ title: "i18n key usage", ...properties })
    .map(([key, value]) => `${key}=${escapeProperty(value)}`)
    .join(",");
  return `::${level} ${props}::${escapeData(message)}`;
}
