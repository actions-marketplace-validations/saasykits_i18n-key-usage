import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseTsconfig } from "get-tsconfig";
import { z } from "zod";
import { ADAPTERS } from "./adapters";
import { DEFAULT_CATALOGS, DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from "./analyzer/defaults";
import type { IUsageOptions } from "./analyzer/types";

export const CONFIG_FILE = "i18n-key-usage.config.json";

const symbolRef = z.object({
  file: z.string().min(1).describe("File path relative to the project root."),
  export: z.string().min(1).describe("Export name."),
});

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    library: z
      .enum(Object.keys(ADAPTERS) as [string, ...string[]])
      .default("next-intl")
      .describe("i18n library whose translators and catalogs are recognized."),
    messages: z
      .string()
      .min(1)
      .describe(
        "Source-locale catalog: a JSON file, or a directory with one JSON file per top-level namespace.",
      ),
    catalogs: z
      .array(z.string())
      .default(DEFAULT_CATALOGS)
      .describe("Globs of catalog files or directories. Importing one is a catalog read."),
    include: z.array(z.string()).default(DEFAULT_INCLUDE).describe("Globs of sources to scan."),
    exclude: z.array(z.string()).default(DEFAULT_EXCLUDE).describe("Globs excluded from include."),
    tsconfig: z
      .string()
      .default("tsconfig.json")
      .describe("tsconfig whose compilerOptions.paths resolve import aliases."),
    keyTypes: z
      .array(symbolRef)
      .default([])
      .describe("Types whose values are message keys, e.g. a TMessageKey alias."),
    translatorTypes: z
      .array(symbolRef)
      .default([])
      .describe("Types whose values are translators, e.g. an interface with a call signature."),
    messageLoaders: z
      .array(symbolRef)
      .default([])
      .describe("Functions that return the whole catalog."),
    keyFunctions: z
      .array(symbolRef.extend({ argument: z.number().int().min(0) }))
      .default([])
      .describe("Functions whose argument at `argument` (zero-based) is a message key."),
    keyProperties: z
      .array(z.string())
      .default([])
      .describe('Object properties whose string values are message keys, e.g. "labelKey".'),
    validationLibraries: z
      .array(z.string())
      .default([])
      .describe('Modules whose call arguments may be message keys, e.g. "zod".'),
    literalKeyPrefixes: z
      .array(z.string())
      .default([])
      .describe('Any string literal with one of these prefixes is a message key, e.g. "errors.".'),
    families: z
      .array(z.string().min(1))
      .default([])
      .describe(
        "Dynamic key families, e.g. orders.status.{{EOrderStatus}}. Each {{Name}} expands to the values of an exported enum, object, array or string union; {{path/file.ts#Name}} picks one file.",
      ),
    retained: z
      .array(z.string().min(1))
      .default([])
      .describe("Keys kept although no code references them, e.g. for historical data."),
  })
  .strict();

export type TConfig = z.infer<typeof configSchema>;

export interface ILoadedConfig {
  options: IUsageOptions;
  /** Catalog file that defines each key, relative to the root. */
  keyFiles: Map<string, string>;
}

export class ConfigError extends Error {}

export interface ILoadOptions {
  /** Config file relative to the root. When omitted, the default file is used if it exists. */
  file?: string;
  /** Values that replace the file's, e.g. from CLI flags or environment variables. */
  overrides?: Partial<Record<keyof TConfig, unknown>>;
}

export function loadConfig(root: string, options: ILoadOptions | string = {}): ILoadedConfig {
  const { file, overrides = {} } = typeof options === "string" ? { file: options } : options;
  const path = resolve(root, file ?? CONFIG_FILE);
  let json: unknown = {};
  if (existsSync(path)) {
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new ConfigError(`Invalid JSON in ${path}: ${(error as Error).message}`);
    }
  } else if (file !== undefined) throw new ConfigError(`Config file not found: ${path}`);
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new ConfigError(`Config ${path} must be a JSON object`);
  const merged: Record<string, unknown> = { ...json };
  for (const [key, value] of Object.entries(overrides))
    if (value !== undefined) merged[key] = value;
  if (merged.messages === undefined)
    throw new ConfigError(
      `No message catalog: set "messages" in ${CONFIG_FILE}, pass --messages or set I18N_KEY_USAGE_MESSAGES`,
    );
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success)
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  return resolveConfig(resolve(root), parsed.data);
}

export function resolveConfig(root: string, config: TConfig): ILoadedConfig {
  const keyFiles = readCatalog(root, config.messages);
  const adapter = ADAPTERS[config.library];
  if (!adapter) throw new ConfigError(`Unknown library: ${config.library}`);
  return {
    keyFiles,
    options: {
      root,
      keys: keyFiles.keys(),
      include: config.include,
      exclude: config.exclude,
      catalogs: config.catalogs,
      paths: readPaths(root, config.tsconfig),
      adapter,
      keyTypes: config.keyTypes,
      translatorTypes: config.translatorTypes,
      messageLoaders: config.messageLoaders,
      keyFunctions: config.keyFunctions,
      keyProperties: config.keyProperties,
      validationLibraries: config.validationLibraries,
      literalKeyPrefixes: config.literalKeyPrefixes,
      families: config.families,
      retained: config.retained,
    },
  };
}

function readCatalog(root: string, messages: string): Map<string, string> {
  const path = resolve(root, messages);
  if (!existsSync(path)) throw new ConfigError(`Messages not found: ${path}`);
  const keys = new Map<string, string>();
  const add = (file: string, prefix: string) => {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new ConfigError(`Invalid JSON in ${file}: ${(error as Error).message}`);
    }
    const name = relative(root, file).replaceAll("\\", "/");
    for (const key of catalogKeys(json, prefix, name)) keys.set(key, name);
  };
  if (statSync(path).isDirectory()) {
    for (const file of readdirSync(path)
      .filter((item) => item.endsWith(".json"))
      .sort())
      add(resolve(path, file), file.slice(0, -".json".length));
  } else add(path, "");
  return keys;
}

function catalogKeys(value: unknown, prefix: string, file: string): string[] {
  if (typeof value === "string") return [prefix];
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConfigError(`Invalid message ${prefix || "(root)"} in ${file}`);
  return Object.entries(value).flatMap(([key, message]) =>
    catalogKeys(message, prefix ? `${prefix}.${key}` : key, file),
  );
}

/** tsconfig `paths`, rewritten relative to the project root. */
function readPaths(root: string, tsconfig: string): Record<string, string[]> {
  const path = resolve(root, tsconfig);
  if (!existsSync(path)) return {};
  const options = parseTsconfig(path).compilerOptions;
  if (!options?.paths) return {};
  const base = resolve(dirname(path), options.baseUrl ?? ".");
  return Object.fromEntries(
    Object.entries(options.paths).map(([pattern, targets]) => [
      pattern,
      targets.map((target) => relative(root, resolve(base, target)).replaceAll("\\", "/")),
    ]),
  );
}
