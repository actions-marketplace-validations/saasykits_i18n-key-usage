import type { AstTree, NodePath, TFunctionNode, TNode } from "../ast/path";

export type TUsagePath = NodePath;

export enum EUsageValueKind {
  Unknown = "unknown",
  Text = "text",
  Object = "object",
  Array = "array",
  Function = "function",
  Signature = "signature",
  StateSetter = "state-setter",
  Translator = "translator",
  Catalog = "catalog",
  Reference = "reference",
  Union = "union",
  Expression = "expression",
  Type = "type",
  Factory = "factory",
  Typed = "typed",
}

export enum EUsageFactory {
  Translations = "translations",
  Translator = "translator",
  Messages = "messages",
  State = "state",
}

export interface IUsageModule {
  file: string;
  code: string;
  tree: AstTree;
  declarations: Map<string, TUsagePath>;
  exports: Map<string, TUsagePath>;
}

export interface IUsageContext {
  module: IUsageModule;
  parameters: Map<TNode, TUsageValue>;
  active: Set<TNode>;
}

export type TUsageValue =
  | { kind: EUsageValueKind.Unknown }
  | { kind: EUsageValueKind.Reference }
  | { kind: EUsageValueKind.Text; parts: (string | null)[] }
  | {
      kind: EUsageValueKind.Object;
      properties: Map<string, TUsageValue>;
      enum?: true;
      map?: true;
    }
  | { kind: EUsageValueKind.Array; elements: TUsageValue[] }
  | {
      kind: EUsageValueKind.Function;
      path: NodePath<TFunctionNode>;
      context: IUsageContext;
    }
  | {
      kind: EUsageValueKind.Signature;
      parameters: TUsageValue[];
      returns: TUsageValue;
    }
  | { kind: EUsageValueKind.StateSetter; state: TUsageValue }
  | { kind: EUsageValueKind.Translator; namespaces: TUsageValue }
  | { kind: EUsageValueKind.Catalog; prefix: string }
  | { kind: EUsageValueKind.Union; values: TUsageValue[] }
  | {
      kind: EUsageValueKind.Expression;
      path: TUsagePath;
      context: IUsageContext;
    }
  | { kind: EUsageValueKind.Type; path: TUsagePath; context: IUsageContext }
  | { kind: EUsageValueKind.Typed; value: TUsageValue; declared: TUsageValue }
  | { kind: EUsageValueKind.Factory; factory: EUsageFactory };

export interface IUsageSource {
  file: string;
  code: string;
}

export interface IUsageDiagnostic {
  file: string;
  line: number;
  expression: string;
  message: string;
}

export interface IUsageResult {
  used: Set<string>;
  unused: string[];
  missing: IUsageDiagnostic[];
  unresolved: IUsageDiagnostic[];
  invalidDeclarations: string[];
  files: number;
}

export interface IUsageFamily {
  pattern: string;
  source: string;
  export: string;
  reason: string;
}

export interface IRetainedMessage {
  key: string;
  reason: string;
}

/** An exported symbol, by file path relative to the project root and export name. */
export interface ISymbolRef {
  file: string;
  export: string;
}

/** A function whose argument at `argument` (zero-based) is a message key. */
export interface IKeyFunction extends ISymbolRef {
  argument: number;
}

/** How an i18n library exposes translators and catalogs. */
export interface II18nAdapter {
  name: string;
  /** Module specifier to export name to the factory it creates. */
  factories: Record<string, Record<string, EUsageFactory>>;
  /** Option-object property that selects the namespace, e.g. `getTranslations({ namespace })`. */
  namespaceOption: string;
  /** Translator methods whose first argument is a key, e.g. `t.rich(key)`. */
  keyMethods: string[];
  /** Translator methods that read a whole message subtree, e.g. `t.raw(key)`. */
  rawMethods: string[];
  /** Translator methods that only test whether a key exists, e.g. `t.has(key)`. */
  probeMethods: string[];
}

export interface IUsageOptions {
  /** Absolute project root; every other path is relative to it. */
  root: string;
  /** Every key in the source-locale catalog, dot-joined. */
  keys: Iterable<string>;
  /** In-memory sources instead of reading `include` from disk (used by tests). */
  sources?: IUsageSource[];
  /** Globs of application sources to scan. */
  include?: string[];
  /** Globs excluded from `include`. */
  exclude?: string[];
  /** Globs of catalog files or directories; importing one counts as a catalog read, not usage. */
  catalogs?: string[];
  /** tsconfig-style path aliases, already relative to `root`. */
  paths?: Record<string, string[]>;
  adapter?: II18nAdapter;
  /** Types whose values are message keys (`type TMessageKey = ...`). */
  keyTypes?: ISymbolRef[];
  /** Types whose values are translators (`interface ITranslator { (key): string }`). */
  translatorTypes?: ISymbolRef[];
  /** Functions that return the whole catalog. */
  messageLoaders?: ISymbolRef[];
  /** Functions whose argument is a message key, e.g. `translateMessage(t, key)`. */
  keyFunctions?: IKeyFunction[];
  /** Object properties whose string values are message keys, e.g. `{ labelKey: "a.b" }`. */
  keyProperties?: string[];
  /** Modules whose call arguments may be message keys, e.g. `z.string().min(1, "errors.x")`. */
  validationLibraries?: string[];
  /** Any string literal with one of these prefixes is a message key, e.g. `"errors."`. */
  literalKeyPrefixes?: string[];
  families?: IUsageFamily[];
  retained?: IRetainedMessage[];
  onFile?: (file: string, index: number) => void;
}
