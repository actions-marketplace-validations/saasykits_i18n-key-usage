import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkMessageUsage } from "../src/analyzer/check";
import { ConfigError, loadConfig } from "../src/config";
import { createReport, formatGithub, formatText, hasProblems } from "../src/report";

let root: string;

function write(file: string, content: unknown) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

function run(config: Record<string, unknown> = {}) {
  write("i18n-key-usage.config.json", { messages: "messages/en.json", ...config });
  const { options, keyFiles } = loadConfig(root);
  return createReport(checkMessageUsage(options), keyFiles);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "i18n-key-usage-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("config", () => {
  it("reads a single-file catalog and scans sources with default globs", () => {
    write("messages/en.json", { home: { title: "Home", unused: "Unused" } });
    write(
      "app/page.tsx",
      "import { useTranslations } from 'next-intl'; export function Page() { const t = useTranslations('home'); return t('title'); }",
    );
    write("app/page.test.tsx", "t('home.unused');");
    write("node_modules/lib/index.ts", "t('home.unused');");
    const report = run();
    expect(report.unused).toEqual([{ key: "home.unused", file: "messages/en.json" }]);
    expect(report.files).toBe(1);
  });

  it("reads one JSON file per namespace from a catalog directory", () => {
    write("messages/en/common.json", { save: "Save" });
    write("messages/en/home.json", { title: "Home" });
    write(
      "src/page.ts",
      "import { getTranslations } from 'next-intl/server'; export async function f() { const t = await getTranslations(); return t('common.save'); }",
    );
    const report = run({ messages: "messages/en" });
    expect(report.unused).toEqual([{ key: "home.title", file: "messages/en/home.json" }]);
  });

  it("resolves tsconfig path aliases for key types", () => {
    write("messages/en.json", { status: { open: "Open", closed: "Closed" } });
    write("tsconfig.json", { compilerOptions: { baseUrl: ".", paths: { "~/*": ["lib/*"] } } });
    write("lib/keys.ts", "export type TKey = string;");
    write(
      "lib/labels.ts",
      "import type { TKey } from '~/keys'; export const LABELS: Record<string, TKey> = { a: 'status.open', b: 'status.closed' };",
    );
    const report = run({ keyTypes: [{ file: "lib/keys.ts", export: "TKey" }] });
    expect(report.unused).toEqual([]);
  });

  it("treats catalog imports as catalog reads, not usage", () => {
    write("messages/en.json", { home: { title: "Home" } });
    write("src/provider.ts", "import messages from '../messages/en.json'; export { messages };");
    const report = run();
    expect(report.unused.map(({ key }) => key)).toEqual(["home.title"]);
  });

  it("reports missing keys with locations", () => {
    write("messages/en.json", { home: { title: "Home" } });
    write(
      "src/page.ts",
      "import { useTranslations } from 'next-intl';\nconst t = useTranslations();\nt('home.title');\nt('home.missing');",
    );
    const report = run();
    expect(report.missing).toEqual([
      {
        file: "src/page.ts",
        line: 4,
        expression: "t('home.missing')",
        message: "Unknown message key: home.missing",
      },
    ]);
    expect(hasProblems(report)).toBe(true);
    expect(formatText(report)).toContain("src/page.ts:4: Unknown message key: home.missing");
    expect(formatGithub(report)).toContain(
      "::error title=i18n key usage,file=src/page.ts,line=4::Unknown message key: home.missing: t('home.missing')",
    );
  });

  it("rejects unknown options and missing catalogs", () => {
    write("messages/en.json", {});
    expect(() => run({ unknown: true })).toThrow(ConfigError);
    expect(() => run({ messages: "messages/fr.json" })).toThrow(/Messages not found/);
  });

  it("rejects catalog values that are not strings or objects", () => {
    write("messages/en.json", { list: ["a"] });
    expect(() => run()).toThrow(/Invalid message list/);
  });
});

describe("github report", () => {
  it("prefixes annotation paths with the project directory", () => {
    write("messages/en.json", { home: { title: "Home" } });
    write("src/page.ts", "export {};");
    expect(formatGithub(run(), "apps/web")).toContain(
      "::error title=i18n key usage,file=apps/web/messages/en.json::Unused message key: home.title",
    );
  });
});
