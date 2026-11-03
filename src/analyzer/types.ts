import type { NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

export type TUsagePath = NodePath<t.Node | null | undefined>;

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
  program: NodePath<t.Program>;
  declarations: Map<string, TUsagePath>;
  exports: Map<string, TUsagePath>;
}

export interface IUsageContext {
  module: IUsageModule;
  parameters: Map<t.Node, TUsageValue>;
  active: Set<t.Node>;
}

export type TUsageValue =
  | { kind: EUsageValueKind.Unknown }
  | { kind: EUsageValueKind.Reference }
  | { kind: EUsageValueKind.Text; parts: (string | null)[] }
  | { kind: EUsageValueKind.Object; properties: Map<string, TUsageValue>; enum?: true; map?: true }
  | { kind: EUsageValueKind.Array; elements: TUsageValue[] }
  | { kind: EUsageValueKind.Function; path: NodePath<t.Function>; context: IUsageContext }
  | { kind: EUsageValueKind.Signature; parameters: TUsageValue[]; returns: TUsageValue }
  | { kind: EUsageValueKind.StateSetter; state: TUsageValue }
  | { kind: EUsageValueKind.Translator; namespaces: TUsageValue }
  | { kind: EUsageValueKind.Catalog; prefix: string }
  | { kind: EUsageValueKind.Union; values: TUsageValue[] }
  | { kind: EUsageValueKind.Expression; path: TUsagePath; context: IUsageContext }
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

export interface IUsageOptions {
  root: string;
  keys: Iterable<string>;
  sources?: IUsageSource[];
  families?: IUsageFamily[];
  retained?: IRetainedMessage[];
  onFile?: (file: string, index: number) => void;
}
