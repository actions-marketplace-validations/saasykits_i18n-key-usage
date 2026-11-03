import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import picomatch from "picomatch";
import { globSync } from "tinyglobby";
import { AstTree, keyName } from "../ast/path";
import { DEFAULT_CATALOGS, DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from "./defaults";
import { child, children } from "./paths";
import type { ISymbolRef, IUsageModule, IUsageOptions, TUsagePath } from "./types";
import { MAX_MODULE_CACHE } from "./values";

export class UsageProject {
  readonly root: string;
  readonly files: string[];
  readonly keys: Set<string>;
  private readonly sources: Map<string, string> | undefined;
  private readonly modules = new Map<string, IUsageModule>();
  private readonly aliases: [string, string[]][];
  private readonly isCatalog: (path: string) => boolean;

  constructor(readonly options: IUsageOptions) {
    this.root = resolve(options.root);
    this.keys = new Set(options.keys);
    this.aliases = Object.entries(options.paths ?? {});
    this.isCatalog = picomatch(options.catalogs ?? DEFAULT_CATALOGS);
    this.sources = options.sources
      ? new Map(options.sources.map(({ file, code }) => [resolve(this.root, file), code]))
      : undefined;
    const include = options.include ?? DEFAULT_INCLUDE;
    const exclude = options.exclude ?? DEFAULT_EXCLUDE;
    if (this.sources) {
      const included = picomatch(include, { ignore: exclude });
      this.files = [...this.sources.keys()].filter((file) => included(this.relative(file))).sort();
    } else {
      this.files = globSync(include, { cwd: this.root, ignore: exclude, absolute: true })
        .map((file) => resolve(file))
        .sort();
    }
  }

  /** Scanned files that declare and export `name` themselves (re-exports are skipped). */
  declaringFiles(name: string): string[] {
    const word = new RegExp(`\\b${name.replace(/[$]/g, "\\$&")}\\b`);
    return this.files.filter((file) => {
      if (!word.test(this.source(file))) return false;
      const module = this.module(file);
      return module.declarations.has(name) && module.exports.has(name);
    });
  }

  /** Whether `file` declares `name` as one of `refs`. */
  matches(refs: ISymbolRef[] | undefined, file: string, name: string): boolean {
    const path = this.relative(file);
    return refs?.some((ref) => ref.file === path && ref.export === name) ?? false;
  }

  relative(file: string): string {
    return relative(this.root, file).replaceAll("\\", "/");
  }

  source(file: string): string {
    const absolute = resolve(this.root, file);
    return this.sources?.get(absolute) ?? readFileSync(absolute, "utf8");
  }

  /** Absolute paths a specifier may point to before extensions are added. */
  private bases(from: string, specifier: string): string[] {
    if (specifier.startsWith(".")) return [resolve(dirname(from), specifier)];
    return this.aliases.flatMap(([pattern, targets]) => {
      const star = pattern.indexOf("*");
      if (star === -1)
        return pattern === specifier ? targets.map((target) => resolve(this.root, target)) : [];
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (
        !specifier.startsWith(prefix) ||
        !specifier.endsWith(suffix) ||
        specifier.length < prefix.length + suffix.length
      )
        return [];
      const rest = specifier.slice(prefix.length, specifier.length - suffix.length);
      return targets.map((target) => resolve(this.root, target.replace("*", rest)));
    });
  }

  resolveImport(from: string, specifier: string): string | undefined {
    for (const base of this.bases(from, specifier)) {
      const stem = base.replace(/\.jsx?$/, "");
      const found = [
        base,
        `${stem}.ts`,
        `${stem}.tsx`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
      ].find(
        (file) =>
          this.sources?.has(file) || (!this.sources && existsSync(file) && statSync(file).isFile()),
      );
      if (found) return found;
    }
    return undefined;
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
      path?.is("ExportSpecifier") &&
      path.parentPath?.is("ExportNamedDeclaration") &&
      path.parentPath.node.source
    ) {
      const source = this.resolveImport(file, path.parentPath.node.source.value);
      const local = keyName(path.node.local);
      return source && local !== undefined ? this.exported(source, local, next) : undefined;
    }
    if (path) return { module, path };
    for (const statement of children(module.tree.program, "body")) {
      if (!statement.is("ExportAllDeclaration") || statement.node.exported) continue;
      const source = this.resolveImport(file, statement.node.source.value);
      const found = source ? this.exported(source, name, next) : undefined;
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Namespace prefix of an imported catalog, e.g. `""` for `messages/en` and `"common"` for
   * `messages/en/common.json`; undefined when the import is not a catalog.
   */
  catalogImport(from: string, specifier: string): string | undefined {
    for (const base of this.bases(from, specifier)) {
      const path = this.relative(base)
        .replace(/\.(?:json|tsx?)$/, "")
        .replace(/\/index$/, "");
      const segments = path.split("/");
      for (let length = segments.length; length > 0; length -= 1) {
        const catalog = segments.slice(0, length).join("/");
        if (this.isCatalog(catalog) || this.isCatalog(`${catalog}.json`))
          return segments.slice(length).join(".");
      }
    }
    return undefined;
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
    const tree = new AstTree(absolute, code);
    const declarations = new Map<string, TUsagePath>();
    const exports = new Map<string, TUsagePath>();
    const register = (path: TUsagePath, exported: boolean) => {
      if (path.is("VariableDeclaration")) {
        for (const declaration of children(path, "declarations")) {
          if (!declaration.is("VariableDeclarator")) continue;
          if (declaration.node.id.type === "Identifier") {
            declarations.set(declaration.node.id.name, declaration);
            if (exported) exports.set(declaration.node.id.name, declaration);
          }
        }
      } else if (
        path.is("FunctionDeclaration") ||
        path.is("TSTypeAliasDeclaration") ||
        path.is("TSInterfaceDeclaration") ||
        path.is("TSEnumDeclaration") ||
        path.is("ClassDeclaration")
      ) {
        const id = path.node.id;
        if (id) {
          declarations.set(id.name, path);
          if (exported) exports.set(id.name, path);
        }
      }
    };
    for (const statement of children(tree.program, "body")) {
      if (statement.is("ExportNamedDeclaration")) {
        const declaration = child(statement, "declaration");
        if (declaration.node) register(declaration, true);
        for (const specifier of children(statement, "specifiers")) {
          if (specifier.is("ExportSpecifier")) {
            const name = keyName(specifier.node.exported);
            if (name !== undefined) exports.set(name, specifier);
          }
        }
      } else if (statement.is("ExportDefaultDeclaration")) {
        exports.set("default", child(statement, "declaration"));
      } else {
        register(statement, false);
      }
    }
    const result = { file: absolute, code, tree, declarations, exports };
    this.modules.set(absolute, result);
    while (this.modules.size > MAX_MODULE_CACHE) {
      const first = this.modules.keys().next().value;
      if (first === undefined) break;
      this.modules.delete(first);
    }
    return result;
  }
}
