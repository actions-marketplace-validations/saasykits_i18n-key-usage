import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { UsageEvaluator } from "./evaluator";
import { child, children } from "./paths";
import { UsageProject } from "./project";
import type { TUsagePath } from "./types";
import {
  EUsageFactory,
  EUsageValueKind,
  type IUsageContext,
  type IUsageDiagnostic,
  type IUsageOptions,
  type IUsageResult,
  type TUsageValue,
} from "./types";
import { MAX_EVALUATION_DEPTH, patternText, textValue, UNKNOWN, unionValue } from "./values";

class UsageChecker {
  private readonly project: UsageProject;
  private readonly evaluator: UsageEvaluator;
  private readonly matchedFamilies = new Set<string>();
  private readonly familyValues = new Map<string, string[]>();
  private readonly diagnostics = new Set<string>();
  private readonly checkedCallbacks = new Set<string>();
  private readonly result: IUsageResult = {
    used: new Set(),
    unused: [],
    missing: [],
    unresolved: [],
    invalidDeclarations: [],
    files: 0,
  };

  constructor(private readonly options: IUsageOptions) {
    this.project = new UsageProject(options);
    this.evaluator = new UsageEvaluator(this.project);
  }

  private diagnostic(path: TUsagePath, context: IUsageContext, message: string, missing = false) {
    if (!path.node) throw new Error("Missing source node for a message diagnostic");
    const diagnostic: IUsageDiagnostic = {
      file: this.project.relative(context.module.file),
      line: path.node.loc?.start.line ?? 1,
      expression: context.module.code.slice(path.node.start ?? 0, path.node.end ?? 0),
      message,
    };
    const id = JSON.stringify(diagnostic);
    if (this.diagnostics.has(id)) return;
    this.diagnostics.add(id);
    (missing ? this.result.missing : this.result.unresolved).push(diagnostic);
  }

  private use(key: string, path: TUsagePath, context: IUsageContext, raw: boolean) {
    if (this.project.keys.has(key)) {
      this.result.used.add(key);
      return;
    }
    const descendants = raw
      ? [...this.project.keys].filter((candidate) => candidate.startsWith(`${key}.`))
      : [];
    if (descendants.length) {
      for (const candidate of descendants) this.result.used.add(candidate);
      return;
    }
    this.diagnostic(path, context, `Unknown message key: ${key}`, true);
  }

  private family(pattern: string): string[] | undefined {
    const family = this.options.families?.find((item) => item.pattern === pattern);
    if (!family) return undefined;
    this.matchedFamilies.add(pattern);
    const cached = this.familyValues.get(pattern);
    if (cached) return cached;
    if (!family.reason.trim() || (pattern.match(/\*/g) ?? []).length !== 1) {
      this.result.invalidDeclarations.push(`Invalid dynamic family declaration: ${pattern}`);
      return [];
    }
    const context = this.evaluator.context(family.source);
    const declaration = context.module.exports.get(family.export);
    const value = declaration ? this.evaluator.evaluate(declaration, context) : UNKNOWN;
    const strings = this.evaluator.strings(this.evaluator.property(value, undefined));
    if (!strings.length)
      this.result.invalidDeclarations.push(
        `Dynamic family ${pattern} has no finite values in ${family.source}:${family.export}`,
      );
    const keys = [...new Set(strings.map((value) => pattern.replace("*", value)))];
    this.familyValues.set(pattern, keys);
    return keys;
  }

  private consume(
    value: TUsageValue,
    namespaces: TUsageValue,
    path: TUsagePath,
    context: IUsageContext,
    raw = false,
  ) {
    const prefixes = this.evaluator.strings(namespaces);
    if (!prefixes.length) {
      this.diagnostic(path, context, "Cannot resolve translator namespace");
      return;
    }
    for (const item of this.evaluator.alternatives(value)) {
      if (item.kind === EUsageValueKind.Reference) continue;
      const parts = item.kind === EUsageValueKind.Text ? item.parts : [null];
      const candidates = prefixes.map((prefix) => [...(prefix ? [`${prefix}.`] : []), ...parts]);
      const hasValidNamespace =
        prefixes.length > 1 &&
        candidates.some(
          (full) =>
            !full.includes(null) &&
            (this.project.keys.has(full.join("")) ||
              (raw && [...this.project.keys].some((key) => key.startsWith(`${full.join("")}.`)))),
        );
      for (const prefix of prefixes) {
        const full = [...(prefix ? [`${prefix}.`] : []), ...parts];
        if (full.includes(null)) {
          const pattern = patternText(full);
          const keys = this.family(pattern);
          if (keys) for (const key of keys) this.use(key, path, context, false);
          else this.diagnostic(path, context, `Cannot resolve dynamic message key: ${pattern}`);
        } else {
          const key = full.join("");
          if (
            !hasValidNamespace ||
            this.project.keys.has(key) ||
            (raw && [...this.project.keys].some((candidate) => candidate.startsWith(`${key}.`)))
          )
            this.use(key, path, context, raw);
        }
      }
    }
  }

  private typed(
    value: TUsageValue,
    declared: TUsageValue,
    path: TUsagePath,
    context: IUsageContext,
    depth = 0,
  ) {
    if (depth > MAX_EVALUATION_DEPTH) return;
    for (const type of this.evaluator.alternatives(declared, depth + 1)) {
      if (type.kind === EUsageValueKind.Reference)
        this.consume(value, textValue(""), path, context);
      if (type.kind === EUsageValueKind.Signature)
        for (const fn of this.evaluator.alternatives(value, depth + 1)) {
          if (fn.kind !== EUsageValueKind.Function) continue;
          if (
            fn.context.parameters.size === 0 &&
            type.returns.kind === EUsageValueKind.Type &&
            type.returns.context.parameters.size === 0
          ) {
            const id = `${fn.context.module.file}:${fn.path.node.start}:${type.returns.context.module.file}:${type.returns.path.node?.start}`;
            if (this.checkedCallbacks.has(id)) continue;
            this.checkedCallbacks.add(id);
          }
          this.typed(
            this.evaluator.invoke(fn, type.parameters, depth + 1),
            type.returns,
            fn.path,
            fn.context,
            depth + 1,
          );
        }
      if (type.kind === EUsageValueKind.Object) {
        const current = this.evaluator.resolve(value, depth + 1);
        for (const [key, field] of type.properties) {
          this.typed(
            this.evaluator.property(current, key === "*" ? undefined : [key], depth + 1),
            field,
            path,
            context,
            depth + 1,
          );
        }
      }
      if (type.kind === EUsageValueKind.Array) {
        const current = this.evaluator.resolve(value, depth + 1);
        for (const [index, element] of type.elements.entries()) {
          this.typed(
            this.evaluator.property(
              current,
              type.elements.length === 1 ? undefined : [String(index)],
              depth + 1,
            ),
            element,
            path,
            context,
            depth + 1,
          );
        }
      }
    }
  }

  private stateValue(argument: TUsagePath, state: TUsageValue, context: IUsageContext) {
    const values = this.evaluator.alternatives(this.evaluator.evaluate(argument, context));
    this.typed(
      unionValue(
        values.map((value) =>
          value.kind === EUsageValueKind.Function ? this.evaluator.invoke(value, [state]) : value,
        ),
      ),
      state,
      argument,
      context,
    );
  }

  private arrayMutation(
    path: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>,
    context: IUsageContext,
  ) {
    const callee = child(path, "callee");
    if (
      (!callee.isMemberExpression() && !callee.isOptionalMemberExpression()) ||
      callee.node.computed ||
      !t.isIdentifier(callee.node.property) ||
      !["push", "unshift", "splice"].includes(callee.node.property.name)
    )
      return;
    const arrays = this.evaluator.alternatives(
      this.evaluator.evaluate(child(callee, "object"), context),
    );
    const element = unionValue(
      arrays.flatMap((value) => (value.kind === EUsageValueKind.Array ? value.elements : [])),
    );
    for (const argument of children(path, "arguments").slice(
      callee.node.property.name === "splice" ? 2 : 0,
    )) {
      const value = argument.isSpreadElement()
        ? this.evaluator.property(
            this.evaluator.evaluate(child(argument, "argument"), context),
            undefined,
          )
        : this.evaluator.evaluate(argument, context);
      this.typed(value, element, argument, context);
    }
  }

  private guarded(path: TUsagePath, context: IUsageContext): boolean {
    if (!path.node) return false;
    const source = path.node;
    const argument = path.isCallExpression() ? children(path, "arguments")[0] : undefined;
    if (!argument?.isIdentifier()) return false;
    for (
      let ancestor: TUsagePath | null = path.parentPath;
      ancestor;
      ancestor = ancestor.parentPath
    ) {
      if (!ancestor.isConditionalExpression() && !ancestor.isIfStatement()) continue;
      const test = child(ancestor, "test");
      if (!test.isCallExpression() || !child(test, "callee").isIdentifier()) continue;
      if (
        (ancestor.node.consequent.start ?? 0) > (source.start ?? 0) ||
        (ancestor.node.consequent.end ?? 0) < (source.end ?? 0)
      )
        continue;
      const fn = this.evaluator.resolve(this.evaluator.evaluate(child(test, "callee"), context));
      if (fn.kind !== EUsageValueKind.Function) continue;
      const returns = child(fn.path, "returnType");
      if (!returns.node || !returns.isTSTypeAnnotation()) continue;
      const predicate = child(returns, "typeAnnotation");
      if (!predicate.isTSTypePredicate() || !t.isIdentifier(predicate.node.parameterName)) continue;
      const annotation = child(predicate, "typeAnnotation");
      if (
        !annotation.node ||
        this.evaluator.type(annotation, fn.context).kind !== EUsageValueKind.Reference
      )
        continue;
      const parameterName = predicate.node.parameterName.name;
      const index = fn.path.node.params.findIndex((parameter) =>
        t.isIdentifier(parameter, { name: parameterName }),
      );
      const checked = children(test, "arguments")[index];
      if (checked?.isIdentifier({ name: argument.node.name })) return true;
    }
    return false;
  }

  private call(
    path: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>,
    context: IUsageContext,
  ) {
    this.arrayMutation(path, context);
    const callee = child(path, "callee");
    let value = this.evaluator.evaluate(callee, context);
    let raw = false;
    let probe = false;
    if (
      (callee.isMemberExpression() || callee.isOptionalMemberExpression()) &&
      t.isIdentifier(callee.node.property) &&
      ["rich", "markup", "raw", "has"].includes(callee.node.property.name)
    ) {
      value = this.evaluator.evaluate(child(callee, "object"), context);
      raw = callee.node.property.name === "raw";
      probe = callee.node.property.name === "has";
    }
    for (const target of this.evaluator.alternatives(value)) {
      const first = children(path, "arguments")[0];
      if (first && target.kind === EUsageValueKind.StateSetter)
        this.stateValue(first, target.state, context);
      if (
        first &&
        target.kind === EUsageValueKind.Factory &&
        target.factory === EUsageFactory.State
      )
        this.stateValue(
          first,
          this.evaluator.property(this.evaluator.evaluate(path, context), ["0"]),
          context,
        );
      if (target.kind === EUsageValueKind.Translator) {
        const argument = children(path, "arguments")[0];
        if (argument && !this.guarded(path, context)) {
          const key = this.evaluator.evaluate(argument, context);
          this.consume(
            probe
              ? unionValue(
                  this.evaluator
                    .alternatives(key)
                    .filter(
                      (value) => value.kind === EUsageValueKind.Text && !value.parts.includes(null),
                    ),
                )
              : key,
            target.namespaces,
            path,
            context,
            raw,
          );
        }
      }
      const functions = path.isNewExpression()
        ? this.evaluator.alternatives(this.evaluator.property(target, ["constructor"]))
        : [target];
      for (const fn of functions) {
        if (fn.kind !== EUsageValueKind.Function) continue;
        if (
          this.project.relative(fn.context.module.file) === "src/i18n/translate.ts" &&
          fn.path.isFunctionDeclaration() &&
          fn.path.node.id?.name === "translateMessage"
        ) {
          const key = children(path, "arguments")[1];
          if (key)
            for (const candidate of this.evaluator.strings(this.evaluator.evaluate(key, context)))
              if (this.project.keys.has(candidate)) this.result.used.add(candidate);
        }
        children(fn.path, "params").forEach((parameter, index) => {
          if (
            !parameter.isIdentifier() &&
            !parameter.isObjectPattern() &&
            !parameter.isArrayPattern() &&
            !parameter.isAssignmentPattern()
          )
            return;
          const annotated = parameter.isAssignmentPattern() ? child(parameter, "left") : parameter;
          if (
            !annotated.isIdentifier() &&
            !annotated.isObjectPattern() &&
            !annotated.isArrayPattern()
          )
            return;
          const annotation = child(annotated, "typeAnnotation");
          const argument = children(path, "arguments")[index];
          if (annotation.node && argument && this.evaluator.references(annotation, fn.context))
            this.typed(
              this.evaluator.evaluate(argument, context),
              this.evaluator.type(annotation, fn.context),
              argument,
              context,
            );
        });
      }
    }
  }

  run(): IUsageResult {
    for (const file of this.project.files) {
      this.options.onFile?.(this.project.relative(file), this.result.files + 1);
      const context = this.evaluator.context(file);
      context.module.program.traverse({
        CallExpression: (path) => this.call(path, context),
        OptionalCallExpression: (path) => this.call(path, context),
        NewExpression: (path) => this.call(path, context),
        VariableDeclarator: (path) => {
          const id = child(path, "id");
          if (!id.isIdentifier() && !id.isObjectPattern() && !id.isArrayPattern()) return;
          const annotation = child(id, "typeAnnotation");
          const init = child(path, "init");
          if (annotation.node && init.node && this.evaluator.references(annotation, context))
            this.typed(
              this.evaluator.evaluate(init, context),
              this.evaluator.type(annotation, context),
              init,
              context,
            );
        },
        TSSatisfiesExpression: (path) => {
          if (this.evaluator.references(child(path, "typeAnnotation"), context))
            this.typed(
              this.evaluator.evaluate(child(path, "expression"), context),
              this.evaluator.type(child(path, "typeAnnotation"), context),
              path,
              context,
            );
        },
        ReturnStatement: (path) => {
          const fn = path.getFunctionParent();
          const argument = child(path, "argument");
          const annotation = fn?.get("returnType");
          if (annotation?.node && argument.node && this.evaluator.references(annotation, context))
            this.typed(
              this.evaluator.evaluate(argument, context),
              this.evaluator.type(annotation, context),
              argument,
              context,
            );
        },
        StringLiteral: (path) => {
          const property = path.parentPath;
          const key =
            property.isObjectProperty() && t.isIdentifier(property.node.key)
              ? property.node.key.name
              : "";
          if (
            ["error", "message", "messageKey", "labelKey", "titleKey", "descriptionKey"].includes(
              key,
            ) &&
            /^[a-zA-Z]+\.[a-zA-Z0-9_.]+$/.test(path.node.value) &&
            !path.findParent((parent) => parent.isTSType())
          )
            this.use(path.node.value, path, context, false);
          const call = path.findParent((parent) => parent.isCallExpression());
          if (call?.isCallExpression()) {
            let base = child(call, "callee");
            while (base.isMemberExpression() || base.isCallExpression())
              base = child(base, base.isMemberExpression() ? "object" : "callee");
            if (base.isIdentifier()) {
              const binding = base.scope.getBinding(base.node.name);
              if (
                binding?.path.isImportSpecifier() &&
                binding.path.parentPath.isImportDeclaration() &&
                binding.path.parentPath.node.source.value === "zod" &&
                /^[a-zA-Z]+\.[a-zA-Z0-9_.]+$/.test(path.node.value)
              )
                this.use(path.node.value, path, context, false);
            }
          }
          if (
            /^errors\.[a-zA-Z0-9_.]+$/.test(path.node.value) &&
            !path.findParent((parent) => parent.isTSType() || parent.isImportDeclaration())
          ) {
            if (
              this.project.keys.has(path.node.value) ||
              ![...this.project.keys].some((key) => key.startsWith(`${path.node.value}.`))
            )
              this.use(path.node.value, path, context, false);
          }
        },
        MemberExpression: (path) => {
          if (path.parentPath.isMemberExpression()) return;
          if (!this.evaluator.catalogOrigin(path, context)) return;
          const value = this.evaluator.resolve(this.evaluator.evaluate(path, context));
          if (value.kind === EUsageValueKind.Catalog && value.prefix)
            this.use(value.prefix, path, context, true);
        },
      });
      this.result.files += 1;
    }
    const retained = new Set<string>();
    for (const entry of this.options.retained ?? []) {
      if (
        !entry.reason.trim() ||
        !this.project.keys.has(entry.key) ||
        this.result.used.has(entry.key) ||
        retained.has(entry.key)
      ) {
        this.result.invalidDeclarations.push(`Invalid or stale retained key: ${entry.key}`);
      }
      retained.add(entry.key);
    }
    for (const family of this.options.families ?? []) {
      if (!this.matchedFamilies.has(family.pattern))
        this.result.invalidDeclarations.push(
          `Unused dynamic family declaration: ${family.pattern}`,
        );
    }
    this.result.unused = [...this.project.keys]
      .filter((key) => !this.result.used.has(key) && !retained.has(key))
      .sort();
    return this.result;
  }
}

export function checkMessageUsage(options: IUsageOptions): IUsageResult {
  return new UsageChecker(options).run();
}
