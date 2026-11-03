import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import babelTraverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { child, children } from "./paths";
import type { IUsageModule, IUsageOptions, TUsagePath } from "./types";
import { isProductionSource, MAX_MODULE_CACHE } from "./values";

const TRAVERSE_MODULE: unknown = babelTraverse;
const TRAVERSE =
  typeof TRAVERSE_MODULE === "function"
    ? babelTraverse
    : (TRAVERSE_MODULE as { default: typeof babelTraverse }).default;

export class UsageProject {
  readonly root: string;
  readonly files: string[];
  readonly keys: Set<string>;
  private readonly sources: Map<string, string> | undefined;
  private readonly modules = new Map<string, IUsageModule>();

  constructor(options: IUsageOptions) {
    this.root = resolve(options.root);
    this.keys = new Set(options.keys);
    this.sources = options.sources
      ? new Map(options.sources.map(({ file, code }) => [resolve(this.root, file), code]))
      : undefined;
    this.files = (
      this.sources
        ? [...this.sources.keys()]
        : readdirSync(resolve(this.root, "src"), { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => resolve(entry.parentPath, entry.name))
    )
      .filter((file) => isProductionSource(this.relative(file)))
      .sort();
  }

  relative(file: string): string {
    return relative(this.root, file).replaceAll("\\", "/");
  }

  source(file: string): string {
    const absolute = resolve(this.root, file);
    return this.sources?.get(absolute) ?? readFileSync(absolute, "utf8");
  }

  resolveImport(from: string, specifier: string): string | undefined {
    const base = specifier.startsWith("@/")
      ? resolve(this.root, "src", specifier.slice(2))
      : specifier.startsWith(".")
        ? resolve(dirname(from), specifier)
        : undefined;
    if (!base) return undefined;
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(
      (file) =>
        this.sources?.has(file) || (!this.sources && existsSync(file) && statSync(file).isFile()),
    );
  }

  exported(
    file: string,
    name: string,
    seen = new Set<string>(),
  ): { module: IUsageModule; path: TUsagePath } | undefined {
    const key = `${file}:${name}`;
    if (seen.has(key)) return undefined;
    const next = new Set(seen).add(key);
    const module = this.module(file);
    const path = module.exports.get(name);
    if (
      path?.isExportSpecifier() &&
      path.parentPath.isExportNamedDeclaration() &&
      path.parentPath.node.source
    ) {
      const source = this.resolveImport(file, path.parentPath.node.source.value);
      return source ? this.exported(source, path.node.local.name, next) : undefined;
    }
    if (path) return { module, path };
    for (const statement of children(module.program, "body")) {
      if (!statement.isExportAllDeclaration()) continue;
      const source = this.resolveImport(file, statement.node.source.value);
      const found = source ? this.exported(source, name, next) : undefined;
      if (found) return found;
    }
    return undefined;
  }

  catalogImport(from: string, specifier: string): string | undefined {
    const target = resolve(dirname(from), specifier);
    const path = this.relative(target);
    const match = /^messages\/(?:en|bn)(?:\/(.+))?$/.exec(path);
    if (!match) return undefined;
    return (match[1] ?? "").replace(/(?:\.json|\/index(?:\.ts)?)$/, "");
  }

  module(file: string): IUsageModule {
    const absolute = resolve(this.root, file);
    const cached = this.modules.get(absolute);
    if (cached) {
      this.modules.delete(absolute);
      this.modules.set(absolute, cached);
      return cached;
    }
    const code = this.source(absolute);
    const ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", ...(absolute.endsWith(".tsx") ? ["jsx" as const] : [])],
      attachComment: false,
    });
    let program: NodePath<t.Program> | undefined;
    TRAVERSE(ast, {
      Program(path) {
        program = path;
        path.stop();
      },
    });
    if (!program) throw new Error(`No program in ${this.relative(absolute)}`);
    const declarations = new Map<string, TUsagePath>();
    const exports = new Map<string, TUsagePath>();
    const register = (path: TUsagePath, exported: boolean) => {
      if (path.isVariableDeclaration()) {
        for (const declaration of children(path, "declarations")) {
          if (!declaration.isVariableDeclarator()) continue;
          if (t.isIdentifier(declaration.node.id)) {
            declarations.set(declaration.node.id.name, declaration);
            if (exported) exports.set(declaration.node.id.name, declaration);
          }
        }
      } else if (
        path.isFunctionDeclaration() ||
        path.isTSTypeAliasDeclaration() ||
        path.isTSInterfaceDeclaration() ||
        path.isTSEnumDeclaration() ||
        path.isClassDeclaration()
      ) {
        const id = path.node.id;
        if (id) {
          declarations.set(id.name, path);
          if (exported) exports.set(id.name, path);
        }
      }
    };
    for (const statement of children(program, "body")) {
      if (statement.isExportNamedDeclaration()) {
        const declaration = child(statement, "declaration");
        if (declaration.node) register(declaration, true);
        for (const specifier of children(statement, "specifiers")) {
          if (specifier.isExportSpecifier()) {
            exports.set(
              t.isIdentifier(specifier.node.exported)
                ? specifier.node.exported.name
                : specifier.node.exported.value,
              specifier,
            );
          }
        }
      } else if (statement.isExportDefaultDeclaration()) {
        exports.set("default", child(statement, "declaration"));
      } else {
        register(statement, false);
      }
    }
    const result = { file: absolute, code, program, declarations, exports };
    this.modules.set(absolute, result);
    while (this.modules.size > MAX_MODULE_CACHE) {
      const first = this.modules.keys().next().value;
      if (first === undefined) break;
      this.modules.delete(first);
    }
    return result;
  }
}
