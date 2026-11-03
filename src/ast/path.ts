import { type Node, type Program, parseSync, visitorKeys } from "oxc-parser";

export type TNode = Node;
export type TNodeType = Node["type"];
/** Nodes whose `type` can be `T`; oxc shares one interface for several types (e.g. `Function`). */
export type TNodeOf<T extends TNodeType> = Node extends infer N
  ? N extends Node
    ? [Extract<N["type"], T>] extends [never]
      ? never
      : N
    : never
  : never;
export type TFunctionNode = TNodeOf<
  "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression"
>;
export type TIdentifier = TNodeOf<"Identifier">;

const FUNCTION_TYPES = new Set<string>([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const TYPE_NODE_TYPES = new Set<string>([
  "TSTypeReference",
  "TSTypePredicate",
  "TSTypeQuery",
  "TSTypeLiteral",
  "TSTypeOperator",
  "TSImportType",
]);
const SCOPE_TYPES = new Set<string>([
  "StaticBlock",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "SwitchStatement",
  "CatchClause",
  "ClassDeclaration",
  "ClassExpression",
  "TSModuleBlock",
]);

export class Binding {
  constructor(
    private readonly tree: AstTree,
    private readonly node: Node,
    readonly identifier: TIdentifier,
  ) {}

  /** The declaring path: import specifier, variable declarator, function, class or parameter. */
  get path(): NodePath {
    return this.tree.path(this.node);
  }
}

export class Scope {
  readonly bindings = new Map<string, Binding>();

  constructor(readonly parent: Scope | null) {}

  getBinding(name: string): Binding | undefined {
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      const binding = scope.bindings.get(name);
      if (binding) return binding;
    }
    return undefined;
  }
}

interface ITraversal {
  skipped: boolean;
}

type TVisitor = (path: NodePath) => void;

/** Visitors keyed by ESTree node type; `enter` sees every node. */
export type TVisitors = Partial<Record<TNodeType | "enter", TVisitor>>;

/**
 * Babel-style path over an oxc ESTree node. A path whose `node` is null stands for an absent
 * child, so `get` never returns undefined.
 */
export class NodePath<N extends Node | null = Node | null> {
  private traversal: ITraversal | undefined;

  constructor(
    readonly tree: AstTree,
    readonly node: N,
    private readonly parentNode: Node | null,
  ) {}

  get type(): string | undefined {
    return this.node?.type;
  }

  get parentPath(): NodePath | null {
    const parent = this.node ? this.tree.parentOf(this.node) : this.parentNode;
    return parent ? this.tree.path(parent) : null;
  }

  get scope(): Scope {
    return this.tree.scopeOf(this.node ?? this.parentNode);
  }

  get(key: string): NodePath | NodePath[] {
    const value = this.node ? (this.node as unknown as Record<string, unknown>)[key] : undefined;
    if (Array.isArray(value))
      return value.map((item) =>
        isNode(item) ? this.tree.path(item) : new NodePath(this.tree, null, this.node),
      );
    return isNode(value) ? this.tree.path(value) : new NodePath(this.tree, null, this.node);
  }

  is<T extends TNodeType>(type: T, match?: Record<string, unknown>): this is NodePath<TNodeOf<T>> {
    return isNodeType(this.node, type, match);
  }

  isFunction(): this is NodePath<TFunctionNode> {
    return Boolean(this.node && FUNCTION_TYPES.has(this.node.type));
  }

  isStringLiteral(): this is NodePath<TNodeOf<"Literal"> & { value: string }> {
    return isStringLiteral(this.node);
  }

  isNumericLiteral(): this is NodePath<TNodeOf<"Literal"> & { value: number }> {
    return this.node?.type === "Literal" && typeof this.node.value === "number";
  }

  isNullLiteral(): boolean {
    return this.node?.type === "Literal" && this.node.raw === "null";
  }

  /** Babel's `TSType` alias: any node that is itself a type. */
  isTSType(): boolean {
    const type = this.node?.type;
    return Boolean(
      type?.startsWith("TS") &&
        (type.endsWith("Keyword") ||
          (type.endsWith("Type") && type !== "TSAsExpression") ||
          TYPE_NODE_TYPES.has(type)),
    );
  }

  findParent(predicate: (path: NodePath) => boolean): NodePath | null {
    for (let parent = this.parentPath; parent; parent = parent.parentPath)
      if (predicate(parent)) return parent;
    return null;
  }

  getFunctionParent(): NodePath<TFunctionNode> | null {
    return this.findParent((parent) => parent.isFunction()) as NodePath<TFunctionNode> | null;
  }

  skip(): void {
    if (this.traversal) this.traversal.skipped = true;
  }

  /** Visits descendants in source order, not the path itself. */
  traverse(visitors: TVisitors): void {
    if (!this.node) return;
    for (const child of childNodes(this.node)) this.tree.path(child).visit(visitors);
  }

  private visit(visitors: TVisitors): void {
    if (!this.node) return;
    const traversal: ITraversal = { skipped: false };
    this.traversal = traversal;
    visitors.enter?.(this);
    if (!traversal.skipped) visitors[this.node.type]?.(this);
    this.traversal = undefined;
    if (traversal.skipped) return;
    for (const child of childNodes(this.node)) this.tree.path(child).visit(visitors);
  }
}

/** One parsed file: parent links, scopes and cached paths. */
export class AstTree {
  readonly program: NodePath<Program>;
  private readonly parents = new Map<Node, Node>();
  private readonly paths = new Map<Node, NodePath>();
  private readonly scopes = new Map<Node, Scope>();
  private readonly lines: number[] = [0];

  constructor(
    readonly file: string,
    readonly code: string,
  ) {
    const result = parseSync(file, code, {
      sourceType: "module",
      astType: "ts",
      preserveParens: false,
    });
    const error = result.errors[0];
    if (error) throw new Error(`${file}: ${error.message}`);
    for (let index = code.indexOf("\n"); index !== -1; index = code.indexOf("\n", index + 1))
      this.lines.push(index + 1);
    new ScopeBuilder(this, this.parents, this.scopes).build(result.program);
    this.program = this.path(result.program) as NodePath<Program>;
  }

  path(node: Node): NodePath {
    let path = this.paths.get(node);
    if (!path) {
      path = new NodePath(this, node, null);
      this.paths.set(node, path);
    }
    return path;
  }

  parentOf(node: Node): Node | null {
    return this.parents.get(node) ?? null;
  }

  scopeOf(node: Node | null): Scope {
    for (let current = node; current; current = this.parents.get(current) ?? null) {
      const scope = this.scopes.get(current);
      if (scope) return scope;
    }
    const root = this.scopes.get(this.program.node);
    if (!root) throw new Error(`No program scope in ${this.file}`);
    return root;
  }

  line(offset: number): number {
    let low = 0;
    let high = this.lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.lines[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }
}

/** Registers bindings the way Babel's scope collector does for the node kinds the analyzer reads. */
class ScopeBuilder {
  constructor(
    private readonly tree: AstTree,
    private readonly parents: Map<Node, Node>,
    private readonly scopes: Map<Node, Scope>,
  ) {}

  build(program: Program): void {
    const scope = new Scope(null);
    this.scopes.set(program, scope);
    this.children(program, scope, scope);
  }

  private children(node: Node, scope: Scope, functionScope: Scope): void {
    for (const child of childNodes(node)) {
      this.parents.set(child, node);
      this.visit(child, node, scope, functionScope);
    }
  }

  private visit(node: Node, parent: Node, scope: Scope, functionScope: Scope): void {
    if (node.type === "ImportDeclaration") {
      const program = this.scopes.get(this.root(node));
      for (const specifier of node.specifiers)
        this.bind(program ?? scope, specifier.local, specifier);
    } else if (node.type === "VariableDeclaration") {
      const target = node.kind === "var" ? functionScope : scope;
      for (const declarator of node.declarations)
        for (const identifier of patternIdentifiers(declarator.id))
          this.bind(target, identifier, declarator);
    } else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id)
      this.bind(scope, node.id, node);

    if (FUNCTION_TYPES.has(node.type)) {
      const fn = node as TFunctionNode;
      const own = new Scope(scope);
      this.scopes.set(node, own);
      if (node.type !== "FunctionDeclaration" && "id" in fn && fn.id) this.bind(own, fn.id, fn);
      for (const param of fn.params)
        for (const identifier of patternIdentifiers(param)) this.bind(own, identifier, param);
      this.children(node, own, own);
      return;
    }
    const opens =
      SCOPE_TYPES.has(node.type) ||
      (node.type === "BlockStatement" &&
        !FUNCTION_TYPES.has(parent.type) &&
        parent.type !== "CatchClause");
    if (!opens) {
      this.children(node, scope, functionScope);
      return;
    }
    const own = new Scope(scope);
    this.scopes.set(node, own);
    if (node.type === "CatchClause" && node.param)
      for (const identifier of patternIdentifiers(node.param))
        this.bind(own, identifier, node.param);
    if (node.type === "ClassExpression" && node.id) this.bind(own, node.id, node);
    this.children(node, own, functionScope);
  }

  private root(node: Node): Node {
    let current = node;
    for (let parent = this.parents.get(current); parent; parent = this.parents.get(current))
      current = parent;
    return current;
  }

  private bind(scope: Scope, identifier: TIdentifier, node: Node): void {
    scope.bindings.set(identifier.name, new Binding(this.tree, node, identifier));
  }
}

function patternIdentifiers(node: Node | null): TIdentifier[] {
  if (!node) return [];
  switch (node.type) {
    case "Identifier":
      return [node];
    case "ObjectPattern":
      return node.properties.flatMap((property) =>
        patternIdentifiers(property.type === "RestElement" ? property.argument : property.value),
      );
    case "ArrayPattern":
      return node.elements.flatMap((element) => patternIdentifiers(element));
    case "AssignmentPattern":
      return patternIdentifiers(node.left);
    case "RestElement":
      return patternIdentifiers(node.argument);
    case "TSParameterProperty":
      return patternIdentifiers(node.parameter);
    default:
      return [];
  }
}

function childNodes(node: Node): Node[] {
  const keys = visitorKeys[node.type] ?? [];
  const result: Node[] = [];
  const record = node as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) result.push(item);
    } else if (isNode(value)) result.push(value);
  }
  return result;
}

export function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export function isNodeType<T extends TNodeType>(
  node: Node | null | undefined,
  type: T,
  match?: Record<string, unknown>,
): node is TNodeOf<T> {
  if (node?.type !== type) return false;
  if (!match) return true;
  const record = node as unknown as Record<string, unknown>;
  return Object.entries(match).every(([key, value]) => record[key] === value);
}

export function isStringLiteral(
  node: Node | null | undefined,
): node is TNodeOf<"Literal"> & { value: string } {
  return node?.type === "Literal" && typeof node.value === "string";
}

/** Name of an identifier or string-literal key, as Babel code reads `key.name ?? key.value`. */
export function keyName(node: Node | null | undefined): string | undefined {
  if (node?.type === "Identifier") return node.name;
  if (isStringLiteral(node)) return node.value;
  return undefined;
}
