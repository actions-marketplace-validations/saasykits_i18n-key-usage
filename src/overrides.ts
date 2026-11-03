import { ConfigError, type TConfig } from "./config";

enum EOptionKind {
  String = "string",
  List = "list",
  Symbols = "symbols",
  KeyFunctions = "key-functions",
}

interface IOptionSpec {
  key: keyof TConfig;
  /** Repeatable for lists. */
  flag: string;
  kind: EOptionKind;
  value: string;
  description: string;
}

/** Config options that can also come from a CLI flag or an `I18N_KEY_USAGE_*` variable. */
export const OPTION_SPECS: IOptionSpec[] = [
  {
    key: "messages",
    flag: "messages",
    kind: EOptionKind.String,
    value: "<path>",
    description: "Source-locale catalog file or directory",
  },
  {
    key: "library",
    flag: "library",
    kind: EOptionKind.String,
    value: "<name>",
    description: "i18n library (next-intl)",
  },
  {
    key: "tsconfig",
    flag: "tsconfig",
    kind: EOptionKind.String,
    value: "<file>",
    description: "tsconfig with import aliases",
  },
  {
    key: "include",
    flag: "include",
    kind: EOptionKind.List,
    value: "<glob>",
    description: "Sources to scan",
  },
  {
    key: "exclude",
    flag: "exclude",
    kind: EOptionKind.List,
    value: "<glob>",
    description: "Globs removed from include",
  },
  {
    key: "catalogs",
    flag: "catalog",
    kind: EOptionKind.List,
    value: "<glob>",
    description: "Catalog files or directories",
  },
  {
    key: "keyTypes",
    flag: "key-type",
    kind: EOptionKind.Symbols,
    value: "<file#export>",
    description: "Type whose values are message keys",
  },
  {
    key: "translatorTypes",
    flag: "translator-type",
    kind: EOptionKind.Symbols,
    value: "<file#export>",
    description: "Type whose values are translators",
  },
  {
    key: "messageLoaders",
    flag: "message-loader",
    kind: EOptionKind.Symbols,
    value: "<file#export>",
    description: "Function that returns the catalog",
  },
  {
    key: "keyFunctions",
    flag: "key-function",
    kind: EOptionKind.KeyFunctions,
    value: "<file#export:arg>",
    description: "Function whose argument (zero-based) is a key",
  },
  {
    key: "keyProperties",
    flag: "key-property",
    kind: EOptionKind.List,
    value: "<name>",
    description: "Object property whose string values are keys",
  },
  {
    key: "validationLibraries",
    flag: "validation-library",
    kind: EOptionKind.List,
    value: "<module>",
    description: "Module whose call arguments may be keys",
  },
  {
    key: "families",
    flag: "family",
    kind: EOptionKind.List,
    value: "<pattern>",
    description: "Dynamic key family, e.g. status.{{EStatus}}",
  },
  {
    key: "retained",
    flag: "retain",
    kind: EOptionKind.List,
    value: "<key>",
    description: "Key to keep although nothing references it",
  },
  {
    key: "literalKeyPrefixes",
    flag: "literal-key-prefix",
    kind: EOptionKind.List,
    value: "<prefix>",
    description: "Prefix that makes any string literal a key",
  },
];

export const ENV_PREFIX = "I18N_KEY_USAGE_";

/** `keyTypes` → `I18N_KEY_USAGE_KEY_TYPES`. */
export function envName(key: string): string {
  return `${ENV_PREFIX}${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

export type TFlagValues = Record<string, string | string[] | boolean | undefined>;
export type TOverrides = Partial<Record<keyof TConfig, unknown>>;

/**
 * Config values from CLI flags, then environment variables. A flag replaces the variable, which
 * replaces the config file; list values are not merged.
 */
export function readOverrides(flags: TFlagValues, env: NodeJS.ProcessEnv): TOverrides {
  const overrides: TOverrides = {};
  for (const spec of OPTION_SPECS) {
    const flag = flags[spec.flag];
    const fromFlag = Array.isArray(flag) ? flag : typeof flag === "string" ? [flag] : [];
    const fromEnv = env[envName(spec.key)]?.trim();
    const raw = fromFlag.length ? fromFlag : fromEnv ? [fromEnv] : [];
    if (!raw.length) continue;
    const source = fromFlag.length ? `--${spec.flag}` : envName(spec.key);
    overrides[spec.key] = parse(spec, raw, source);
  }
  return overrides;
}

function parse(spec: IOptionSpec, raw: string[], source: string): unknown {
  if (spec.kind === EOptionKind.String) return raw.at(-1);
  const items = raw.flatMap(splitList);
  if (spec.kind === EOptionKind.List) return items;
  return items.map((item) => {
    const match =
      spec.kind === EOptionKind.Symbols
        ? /^(?<file>[^#]+)#(?<name>[^#:]+)$/.exec(item)
        : /^(?<file>[^#]+)#(?<name>[^#:]+):(?<argument>\d+)$/.exec(item);
    const groups = match?.groups;
    if (!groups?.file || !groups.name)
      throw new ConfigError(`Invalid ${source} value "${item}", expected ${spec.value}`);
    return {
      file: groups.file,
      export: groups.name,
      ...(groups.argument === undefined ? {} : { argument: Number(groups.argument) }),
    };
  });
}

/** Splits on commas and newlines, but not inside `{a,b}` glob braces. */
export function splitList(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "{") depth += 1;
    if (char === "}") depth = Math.max(0, depth - 1);
    if ((char === "," && depth === 0) || char === "\n") {
      items.push(current);
      current = "";
    } else current += char;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

/** `parseArgs` option definitions for every overridable option. */
export function flagDefinitions(): Record<string, { type: "string"; multiple: boolean }> {
  return Object.fromEntries(
    OPTION_SPECS.map((spec) => [
      spec.flag,
      { type: "string" as const, multiple: spec.kind !== EOptionKind.String },
    ]),
  );
}

export function flagHelp(): string {
  const rows = OPTION_SPECS.map((spec) => [`--${spec.flag} ${spec.value}`, spec.description]);
  const width = Math.max(...rows.map(([flag]) => flag?.length ?? 0)) + 2;
  return rows.map(([flag, text]) => `      ${(flag ?? "").padEnd(width)}${text}`).join("\n");
}
