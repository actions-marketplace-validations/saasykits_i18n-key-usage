import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { child, children } from "./paths";
import type { UsageProject } from "./project";
import { evaluateType } from "./type-values";
import type { TUsagePath } from "./types";
import {
  EUsageFactory,
  EUsageValueKind,
  type IUsageContext,
  type TUsageValue,
} from "./types";
import {
  expressionValue,
  MAX_ALTERNATIVES,
  MAX_EVALUATION_DEPTH,
  MESSAGE_REFERENCE,
  textValue,
  typeValue,
  UNKNOWN,
  unionValue,
} from "./values";

export class UsageEvaluator {
  private readonly referenceTypes = new WeakMap<t.Node, boolean>();
  constructor(readonly project: UsageProject) {}

  references(path: TUsagePath, context: IUsageContext, seen = new Set<t.Node>()): boolean {
    if (!path.node || seen.has(path.node)) return false;
    const cached = this.referenceTypes.get(path.node);
    if (cached !== undefined) return cached;
    const next = new Set(seen).add(path.node);
    let result = false;
    if (
      path.isTSTypeAnnotation() ||
      path.isTSTypeAliasDeclaration() ||
      path.isTSParenthesizedType() ||
      path.isTSTypeOperator()
    )
      result = this.references(child(path, "typeAnnotation"), context, next);
    else if (path.isTSUnionType() || path.isTSIntersectionType())
      result = children(path, "types").some((item) => this.references(item, context, next));
    else if (path.isTSArrayType())
      result = this.references(child(path, "elementType"), context, next);
    else if (path.isTSTupleType())
      result = children(path, "elementTypes").some((item) => this.references(item, context, next));
    else if (path.isTSIndexedAccessType())
      result = this.references(child(path, "objectType"), context, next);
    else if (
      path.isTSFunctionType() ||
      path.isTSCallSignatureDeclaration() ||
      path.isTSMethodSignature()
    )
      result =
        this.references(child(path, "typeAnnotation"), context, next) ||
        children(path, "parameters").some((parameter) =>
          this.references(child(parameter, "typeAnnotation"), context, next),
        );
    else if (path.isTSTypeLiteral() || path.isTSInterfaceDeclaration()) {
      const members = path.isTSTypeLiteral()
        ? children(path, "members")
        : children(child(path, "body"), "body");
      result = members.some(
        (member) =>
          (member.isTSPropertySignature() &&
            this.references(child(member, "typeAnnotation"), context, next)) ||
          (member.isTSMethodSignature() && this.references(member, context, next)),
      );
    } else if (path.isTSTypeReference()) {
      const name = child(path, "typeName");
      const parameters = child(path, "typeParameters");
      if (name.isIdentifier()) {
        if (
          name.node.name === "TMessageKey" &&
          this.project.relative(context.module.file) === "src/i18n/i18n.types.ts"
        )
          result = true;
        else if (
          [
            "Record",
            "Partial",
            "Required",
            "Readonly",
            "Pick",
            "Omit",
            "NonNullable",
            "Extract",
            "Exclude",
            "Promise",
            "Awaited",
          ].includes(name.node.name)
        )
          result =
            Boolean(parameters.node) &&
            children(parameters, "params").some((item) => this.references(item, context, next));
        else if (!["ReturnType", "Parameters", "Promise"].includes(name.node.name)) {
          const binding = name.scope.getBinding(name.node.name);
          if (binding?.path.isImportSpecifier() && binding.path.parentPath.isImportDeclaration()) {
            const imported = binding.path.node.imported;
            const exported = t.isIdentifier(imported) ? imported.name : imported.value;
            const file = this.project.resolveImport(
              context.module.file,
              binding.path.parentPath.node.source.value,
            );
            if (file) {
              if (
                this.project.relative(file) === "src/i18n/i18n.types.ts" &&
                exported === "TMessageKey"
              )
                result = true;
              else {
                const found = this.project.exported(file, exported);
                const target = found
                  ? { module: found.module, parameters: new Map(), active: new Set<t.Node>() }
                  : undefined;
                result = found && target ? this.references(found.path, target, next) : false;
              }
            }
          } else {
            const declaration = context.module.declarations.get(name.node.name);
            if (declaration) result = this.references(declaration, context, next);
            else
              for (
                let ancestor: TUsagePath | null = path.parentPath;
                ancestor;
                ancestor = ancestor.parentPath
              ) {
                if (!ancestor.isFunction()) continue;
                const generic = child(ancestor, "typeParameters");
                if (!generic.node) continue;
                const parameter = children(generic, "params").find(
                  (item) => item.isTSTypeParameter() && item.node.name === name.node.name,
                );
                if (parameter?.node && parameter.isTSTypeParameter())
                  result = this.references(child(parameter, "constraint"), context, next);
              }
          }
        }
      }
    }
    this.referenceTypes.set(path.node, result);
    return result;
  }

  catalogOrigin(path: TUsagePath, context: IUsageContext, seen = new Set<t.Node>()): boolean {
    if (!path.node || seen.has(path.node)) return false;
    const next = new Set(seen).add(path.node);
    if (path.isMemberExpression() || path.isOptionalMemberExpression())
      return this.catalogOrigin(child(path, "object"), context, next);
    if (path.isAwaitExpression()) return this.catalogOrigin(child(path, "argument"), context, next);
    if (path.isCallExpression()) {
      const fn = this.resolve(this.evaluate(child(path, "callee"), context));
      return fn.kind === EUsageValueKind.Factory && fn.factory === EUsageFactory.Messages;
    }
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (binding?.path.isVariableDeclarator())
        return this.catalogOrigin(child(binding.path, "init"), context, next);
      if (binding?.path.isImportDefaultSpecifier() && binding.path.parentPath.isImportDeclaration())
        return (
          this.project.catalogImport(
            context.module.file,
            binding.path.parentPath.node.source.value,
          ) !== undefined
        );
    }
    return false;
  }

  context(file: string): IUsageContext {
    return { module: this.project.module(file), parameters: new Map(), active: new Set() };
  }

  resolve(value: TUsageValue, depth = 0): TUsageValue {
    if (depth > MAX_EVALUATION_DEPTH) return UNKNOWN;
    if (value.kind === EUsageValueKind.Expression) {
      return this.resolve(this.evaluate(value.path, value.context, depth + 1), depth + 1);
    }
    if (value.kind === EUsageValueKind.Type) {
      return this.resolve(this.type(value.path, value.context, depth + 1), depth + 1);
    }
    if (value.kind === EUsageValueKind.Typed)
      return this.overlay(value.value, value.declared, depth + 1);
    if (value.kind === EUsageValueKind.Union) {
      return unionValue(value.values.map((item) => this.resolve(item, depth + 1)));
    }
    return value;
  }

  private overlay(value: TUsageValue, declared: TUsageValue, depth: number): TUsageValue {
    if (depth > MAX_EVALUATION_DEPTH) return UNKNOWN;
    const current = this.resolve(value, depth + 1);
    if (current.kind === EUsageValueKind.Unknown) return this.resolve(declared, depth + 1);
    if (current.kind === EUsageValueKind.Union)
      return unionValue(current.values.map((item) => this.overlay(item, declared, depth + 1)));
    const type = this.resolve(declared, depth + 1);
    if (current.kind === EUsageValueKind.Object && type.kind === EUsageValueKind.Object) {
      return {
        ...current,
        properties: new Map([
          ...type.properties,
          ...[...current.properties].map(
            ([key, field]) =>
              [
                key,
                {
                  kind: EUsageValueKind.Typed,
                  value: field,
                  declared: type.properties.get(key) ?? UNKNOWN,
                },
              ] as const,
          ),
        ]),
      };
    }
    if (current.kind === EUsageValueKind.Array && type.kind === EUsageValueKind.Array)
      return { kind: EUsageValueKind.Array, elements: [...current.elements, ...type.elements] };
    return current;
  }

  alternatives(value: TUsageValue, depth = 0): TUsageValue[] {
    const resolved = this.resolve(value, depth + 1);
    return resolved.kind === EUsageValueKind.Union ? resolved.values : [resolved];
  }

  strings(value: TUsageValue, depth = 0): string[] {
    return this.alternatives(value, depth + 1).flatMap((item) =>
      item.kind === EUsageValueKind.Text && item.parts.every((part) => part !== null)
        ? [item.parts.join("")]
        : [],
    );
  }

  property(value: TUsageValue, keys: string[] | undefined, depth = 0): TUsageValue {
    if (depth > MAX_EVALUATION_DEPTH) return UNKNOWN;
    return unionValue(
      this.alternatives(value, depth + 1).flatMap((item) => {
        if (item.kind === EUsageValueKind.Object) {
          return keys
            ? keys.map(
                (key) => item.properties.get(key) ?? item.properties.get("*") ?? unionValue([]),
              )
            : [...item.properties.values()];
        }
        if (item.kind === EUsageValueKind.Array) {
          return keys
            ? keys.map((key) => item.elements[Number(key)] ?? unionValue([]))
            : item.elements;
        }
        if (item.kind === EUsageValueKind.Catalog && keys) {
          return keys.map((key) => ({
            kind: EUsageValueKind.Catalog,
            prefix: item.prefix ? `${item.prefix}.${key}` : key,
          }));
        }
        return [UNKNOWN];
      }),
    );
  }

  type(path: TUsagePath, context: IUsageContext, depth = 0): TUsageValue {
    if (!path.node || depth > MAX_EVALUATION_DEPTH || context.active.has(path.node)) {
      return UNKNOWN;
    }
    return evaluateType(
      this,
      path,
      { ...context, active: new Set(context.active).add(path.node) },
      depth + 1,
    );
  }

  imported(path: TUsagePath, context: IUsageContext, depth = 0): TUsageValue {
    if (
      !path.isImportSpecifier() &&
      !path.isImportDefaultSpecifier() &&
      !path.isImportNamespaceSpecifier()
    )
      return UNKNOWN;
    const declaration = path.parentPath;
    if (!declaration.isImportDeclaration()) return UNKNOWN;
    const source = declaration.node.source.value;
    const name = path.isImportSpecifier()
      ? t.isIdentifier(path.node.imported)
        ? path.node.imported.name
        : path.node.imported.value
      : "default";
    const intl = source === "next-intl" || source === "next-intl/server";
    if (
      intl &&
      [
        "useTranslations",
        "getTranslations",
        "createTranslator",
        "useMessages",
        "getMessages",
      ].includes(name)
    ) {
      return {
        kind: EUsageValueKind.Factory,
        factory:
          name === "createTranslator"
            ? EUsageFactory.Translator
            : ["useMessages", "getMessages"].includes(name)
              ? EUsageFactory.Messages
              : EUsageFactory.Translations,
      };
    }
    if (source === "react" && name === "useState") {
      return { kind: EUsageValueKind.Factory, factory: EUsageFactory.State };
    }
    const catalog = this.project.catalogImport(context.module.file, source);
    if (catalog !== undefined) return { kind: EUsageValueKind.Catalog, prefix: catalog };
    const file = this.project.resolveImport(context.module.file, source);
    if (!file || !/\.tsx?$/.test(file)) return UNKNOWN;
    const relative = this.project.relative(file);
    if (relative === "src/i18n/messages.ts" && name === "loadMessages") {
      return { kind: EUsageValueKind.Factory, factory: EUsageFactory.Messages };
    }
    if (relative === "src/i18n/i18n.types.ts" && name === "TMessageKey") return MESSAGE_REFERENCE;
    if (relative === "src/i18n/translate.ts" && name === "ITranslator") {
      return { kind: EUsageValueKind.Translator, namespaces: textValue("") };
    }
    const imported = this.context(file);
    if (path.isImportNamespaceSpecifier()) {
      return {
        kind: EUsageValueKind.Object,
        properties: new Map(
          [...imported.module.exports].map(([key, value]) => [
            key,
            expressionValue(value, imported),
          ]),
        ),
      };
    }
    const exported = this.project.exported(file, name);
    return exported
      ? this.evaluate(exported.path, { ...imported, module: exported.module }, depth + 1)
      : UNKNOWN;
  }

  identifier(path: NodePath<t.Identifier>, context: IUsageContext, depth: number): TUsageValue {
    const binding = path.scope.getBinding(path.node.name);
    if (binding)
      return this.narrowed(path, this.binding(binding, context, depth + 1), context, depth + 1);
    const declaration = context.module.declarations.get(path.node.name);
    return declaration ? this.evaluate(declaration, context, depth + 1) : UNKNOWN;
  }

  private narrowed(
    path: NodePath<t.Identifier>,
    value: TUsageValue,
    context: IUsageContext,
    depth: number,
  ): TUsageValue {
    const resolved = this.resolve(value, depth + 1);
    if (
      ![EUsageValueKind.Unknown, EUsageValueKind.Text, EUsageValueKind.Union].includes(
        resolved.kind,
      )
    )
      return value;
    let result = value;
    const binding = path.scope.getBinding(path.node.name);
    const apply = (test: TUsagePath, truthy: boolean) => {
      if (test.isUnaryExpression({ operator: "!" })) {
        apply(child(test, "argument"), !truthy);
        return;
      }
      if (test.isBinaryExpression({ operator: "instanceof" })) {
        const left = child(test, "left");
        if (
          truthy &&
          left.isIdentifier({ name: path.node.name }) &&
          left.scope.getBinding(path.node.name) === binding
        )
          result = this.evaluate(child(test, "right"), context, depth + 1);
        return;
      }
      if (!test.isBinaryExpression() || !["===", "!==", "==", "!="].includes(test.node.operator))
        return;
      const left = child(test, "left");
      const right = child(test, "right");
      const target = left.isIdentifier({ name: path.node.name })
        ? left
        : right.isIdentifier({ name: path.node.name })
          ? right
          : undefined;
      if (!target || target.scope.getBinding(path.node.name) !== binding) return;
      const options = this.strings(
        this.evaluate(target === left ? right : left, context, depth + 1),
        depth + 1,
      );
      if (!options.length) return;
      const includes = truthy === ["===", "=="].includes(test.node.operator);
      const current = this.alternatives(result, depth + 1);
      if (includes && current.some((item) => item.kind === EUsageValueKind.Unknown)) {
        result = unionValue(options.map(textValue));
      } else {
        result = unionValue(
          current.filter(
            (item) =>
              item.kind !== EUsageValueKind.Text ||
              item.parts.includes(null) ||
              options.includes(item.parts.join("")) === includes,
          ),
        );
      }
    };
    for (let parent: TUsagePath | null = path.parentPath; parent; parent = parent.parentPath) {
      if (parent.isConditionalExpression() || parent.isIfStatement()) {
        const consequent = parent.node.consequent;
        const alternate = parent.node.alternate;
        if (
          (consequent.start ?? 0) <= (path.node.start ?? 0) &&
          (consequent.end ?? 0) >= (path.node.end ?? 0)
        )
          apply(child(parent, "test"), true);
        if (
          alternate &&
          (alternate.start ?? 0) <= (path.node.start ?? 0) &&
          (alternate.end ?? 0) >= (path.node.end ?? 0)
        )
          apply(child(parent, "test"), false);
      }
      if (parent.isBlockStatement()) {
        for (const statement of children(parent, "body")) {
          if (!statement.isIfStatement() || (statement.node.end ?? 0) >= (path.node.start ?? 0))
            continue;
          const consequent = statement.node.consequent;
          const terminal = t.isBlockStatement(consequent) ? consequent.body.at(-1) : consequent;
          if (t.isReturnStatement(terminal) || t.isThrowStatement(terminal))
            apply(child(statement, "test"), false);
        }
      }
    }
    return result;
  }

  binding(binding: Binding, context: IUsageContext, depth = 0): TUsageValue {
    const path = binding.path;
    if (
      path.isImportSpecifier() ||
      path.isImportDefaultSpecifier() ||
      path.isImportNamespaceSpecifier()
    ) {
      return this.imported(path, context, depth + 1);
    }
    if (path.isVariableDeclarator()) {
      const init = child(path, "init");
      const annotation = child(path, "id");
      const loop = path.parentPath.parentPath;
      const value = init.node
        ? this.evaluate(init, context, depth + 1)
        : loop?.isForOfStatement()
          ? unionValue(
              this.alternatives(
                this.evaluate(child(loop, "right"), context, depth + 1),
                depth + 1,
              ).flatMap((collection) =>
                collection.kind === EUsageValueKind.Object && collection.map
                  ? [...collection.properties].map(([key, value]) => ({
                      kind: EUsageValueKind.Array as const,
                      elements: [key === "*" ? UNKNOWN : textValue(key), value],
                    }))
                  : collection.kind === EUsageValueKind.Array
                    ? collection.elements
                    : [UNKNOWN],
              ),
            )
          : UNKNOWN;
      return this.pattern(annotation, binding.identifier.name, value, context, depth + 1);
    }
    if (
      path.isFunctionDeclaration() ||
      path.isFunctionExpression() ||
      path.isArrowFunctionExpression()
    ) {
      return { kind: EUsageValueKind.Function, path, context };
    }
    const fn = path.findParent((parent) => parent.isFunction());
    if (fn?.isFunction()) {
      const parameter = children(fn, "params").find(
        (item) =>
          item.node &&
          item.node.start !== null &&
          binding.identifier.start !== null &&
          item.node.start !== undefined &&
          binding.identifier.start !== undefined &&
          item.node.start <= binding.identifier.start &&
          (item.node.end ?? 0) >= (binding.identifier.end ?? 0),
      );
      if (parameter?.node) {
        let value = context.parameters.get(parameter.node) ?? UNKNOWN;
        if (value.kind === EUsageValueKind.Unknown) {
          const call = fn.parentPath;
          if (
            call.isCallExpression() &&
            t.isMemberExpression(call.node.callee) &&
            t.isIdentifier(call.node.callee.property) &&
            ["map", "flatMap", "filter", "find", "some", "every", "forEach", "from"].includes(
              call.node.callee.property.name,
            )
          ) {
            const callee = child(call, "callee");
            if (callee.isMemberExpression()) {
              const collection =
                call.node.callee.property.name === "from"
                  ? children(call, "arguments")[0]
                  : child(callee, "object");
              value = collection
                ? this.property(this.evaluate(collection, context, depth + 1), undefined, depth + 1)
                : UNKNOWN;
            }
          }
        }
        return this.pattern(parameter, binding.identifier.name, value, context, depth + 1);
      }
    }
    return this.evaluate(path, context, depth + 1);
  }

  pattern(
    path: TUsagePath,
    name: string,
    value: TUsageValue,
    context: IUsageContext,
    depth = 0,
  ): TUsageValue {
    if (!path.node || depth > MAX_EVALUATION_DEPTH) return UNKNOWN;
    if (path.isIdentifier()) {
      if (path.node.name !== name) return UNKNOWN;
      const annotation = child(path, "typeAnnotation");
      const declared = annotation.node ? this.type(annotation, context, depth + 1) : UNKNOWN;
      const resolved = this.resolve(value, depth + 1);
      return resolved.kind === EUsageValueKind.Unknown
        ? declared
        : annotation.node && this.references(annotation, context)
          ? { kind: EUsageValueKind.Typed, value, declared }
          : value;
    }
    if (path.isAssignmentPattern())
      return this.pattern(
        child(path, "left"),
        name,
        this.resolve(value, depth + 1).kind === EUsageValueKind.Unknown
          ? expressionValue(child(path, "right"), context)
          : value,
        context,
        depth + 1,
      );
    if (path.isObjectPattern()) {
      const annotation = child(path, "typeAnnotation");
      const resolved = this.resolve(value, depth + 1);
      const declared = annotation.node ? typeValue(annotation, context) : UNKNOWN;
      const base =
        resolved.kind === EUsageValueKind.Unknown
          ? declared
          : annotation.node && this.references(annotation, context)
            ? ({ kind: EUsageValueKind.Typed, value, declared } as TUsageValue)
            : value;
      for (const property of children(path, "properties")) {
        if (!property.isObjectProperty()) continue;
        const keys = property.node.computed
          ? this.strings(this.evaluate(child(property, "key"), context, depth + 1))
          : [
              t.isIdentifier(property.node.key)
                ? property.node.key.name
                : t.isStringLiteral(property.node.key)
                  ? property.node.key.value
                  : "",
            ];
        const result = this.pattern(
          child(property, "value"),
          name,
          this.property(base, keys, depth + 1),
          context,
          depth + 1,
        );
        if (this.resolve(result, depth + 1).kind !== EUsageValueKind.Unknown) return result;
      }
    }
    if (path.isArrayPattern()) {
      for (const [index, element] of children(path, "elements").entries()) {
        if (!element.node) continue;
        const result = this.pattern(
          element,
          name,
          this.property(value, [String(index)], depth + 1),
          context,
          depth + 1,
        );
        if (this.resolve(result, depth + 1).kind !== EUsageValueKind.Unknown) return result;
      }
    }
    return UNKNOWN;
  }

  invoke(value: TUsageValue, args: TUsageValue[], depth = 0): TUsageValue {
    if (depth > MAX_EVALUATION_DEPTH) return UNKNOWN;
    return unionValue(
      this.alternatives(value, depth + 1).map((fn) => {
        if (fn.kind === EUsageValueKind.Signature) return fn.returns;
        if (fn.kind !== EUsageValueKind.Function) return UNKNOWN;
        const parameters = new Map(fn.context.parameters);
        fn.path.node.params.forEach((parameter, index) =>
          parameters.set(parameter, args[index] ?? UNKNOWN),
        );
        const context = { ...fn.context, parameters };
        const body = child(fn.path, "body");
        const annotation = child(fn.path, "returnType");
        const wrap = (value: TUsageValue): TUsageValue =>
          annotation.node && this.references(annotation, context)
            ? { kind: EUsageValueKind.Typed, value, declared: typeValue(annotation, context) }
            : value;
        if (!body.isBlockStatement()) return wrap(expressionValue(body, context));
        const returns: TUsageValue[] = [];
        body.traverse({
          Function(path) {
            path.skip();
          },
          ReturnStatement(path) {
            const argument = child(path, "argument");
            if (argument.node) returns.push(expressionValue(argument, context));
          },
        });
        return wrap(unionValue(returns));
      }),
    );
  }

  concatenate(values: TUsageValue[], depth = 0): TUsageValue {
    let patterns: (string | null)[][] = [[]];
    for (const value of values) {
      const options = this.alternatives(value, depth + 1).map((part) =>
        part.kind === EUsageValueKind.Text ? part.parts : [null],
      );
      if (patterns.length * options.length > MAX_ALTERNATIVES) return UNKNOWN;
      patterns = patterns.flatMap((prefix) => options.map((parts) => [...prefix, ...parts]));
    }
    return unionValue(patterns.map((parts) => ({ kind: EUsageValueKind.Text, parts })));
  }

  call(
    path: NodePath<t.CallExpression | t.OptionalCallExpression>,
    context: IUsageContext,
    depth: number,
  ): TUsageValue {
    const callee = child(path, "callee");
    if (callee.isMemberExpression() || callee.isOptionalMemberExpression()) {
      const object = child(callee, "object");
      const name = t.isIdentifier(callee.node.property) ? callee.node.property.name : "";
      if (name === "get") {
        const receiver = this.resolve(this.evaluate(object, context, depth + 1), depth + 1);
        if (receiver.kind === EUsageValueKind.Object && receiver.map) {
          const key = children(path, "arguments")[0];
          const keys = key ? this.strings(this.evaluate(key, context, depth + 1), depth + 1) : [];
          return this.property(receiver, keys.length ? keys : undefined, depth + 1);
        }
      }
      if (object.isIdentifier({ name: "Promise" }) && name === "all") {
        const argument = children(path, "arguments")[0];
        return argument ? this.evaluate(argument, context, depth + 1) : UNKNOWN;
      }
      if (object.isIdentifier({ name: "Object" }) && ["values", "keys", "entries"].includes(name)) {
        const argument = children(path, "arguments")[0];
        const values = argument
          ? this.alternatives(this.evaluate(argument, context, depth + 1), depth + 1)
          : [];
        return {
          kind: EUsageValueKind.Array,
          elements: values.flatMap((value) =>
            value.kind === EUsageValueKind.Object
              ? [...value.properties].map(([key, item]) =>
                  name === "keys"
                    ? textValue(key)
                    : name === "entries"
                      ? { kind: EUsageValueKind.Array, elements: [textValue(key), item] }
                      : item,
                )
              : [],
          ),
        };
      }
      if (["filter", "find", "map", "flatMap"].includes(name)) {
        const collection = this.evaluate(object, context, depth + 1);
        const items = this.property(collection, undefined, depth + 1);
        if (name === "filter") return collection;
        if (name === "find") return items;
        const callback = children(path, "arguments")[0];
        const mapped = callback
          ? this.invoke(this.evaluate(callback, context, depth + 1), [items], depth + 1)
          : UNKNOWN;
        return { kind: EUsageValueKind.Array, elements: [mapped] };
      }
    }
    const fn = this.resolve(this.evaluate(callee, context, depth + 1), depth + 1);
    if (fn.kind === EUsageValueKind.Factory) {
      const argument = children(path, "arguments")[0];
      if (fn.factory === EUsageFactory.Messages)
        return { kind: EUsageValueKind.Catalog, prefix: "" };
      if (fn.factory === EUsageFactory.State) {
        const parameters = child(path, "typeParameters");
        let state: TUsageValue = UNKNOWN;
        if (parameters.node && parameters.isTSTypeParameterInstantiation()) {
          const type = children(parameters, "params")[0];
          if (type) state = this.type(type, context, depth + 1);
        }
        return {
          kind: EUsageValueKind.Array,
          elements: [state, { kind: EUsageValueKind.StateSetter, state }],
        };
      }
      const first = argument ? this.evaluate(argument, context, depth + 1) : textValue("");
      const options =
        fn.factory === EUsageFactory.Translator || (argument?.isObjectExpression() ?? false);
      const objects = this.alternatives(first, depth + 1);
      const namespace =
        options &&
        objects.every(
          (value) => value.kind === EUsageValueKind.Object && !value.properties.has("namespace"),
        )
          ? textValue("")
          : options
            ? this.property(first, ["namespace"], depth + 1)
            : first;
      return { kind: EUsageValueKind.Translator, namespaces: namespace };
    }
    const args = children(path, "arguments").map((argument) => expressionValue(argument, context));
    return this.invoke(fn, args, depth + 1);
  }

  evaluate(path: TUsagePath, context: IUsageContext, depth = 0): TUsageValue {
    if (!path.node || depth > MAX_EVALUATION_DEPTH || context.active.has(path.node)) return UNKNOWN;
    const next = { ...context, active: new Set(context.active).add(path.node) };
    if (path.isStringLiteral()) return textValue(path.node.value);
    if (path.isNumericLiteral()) return textValue(String(path.node.value));
    if (path.isNullLiteral() || path.isIdentifier({ name: "undefined" })) return unionValue([]);
    if (path.isIdentifier()) return this.identifier(path, next, depth + 1);
    if (path.isVariableDeclarator()) {
      const init = child(path, "init");
      return init.node ? this.evaluate(init, next, depth + 1) : UNKNOWN;
    }
    if (path.isExportSpecifier()) return this.evaluate(child(path, "local"), next, depth + 1);
    if (path.isFunction()) return { kind: EUsageValueKind.Function, path, context: next };
    if (path.isTSTypeAliasDeclaration() || path.isTSInterfaceDeclaration())
      return this.type(path, context, depth + 1);
    if (path.isTSEnumDeclaration()) {
      const properties = new Map<string, TUsageValue>();
      for (const member of children(path, "members")) {
        if (!member.isTSEnumMember()) continue;
        properties.set(
          t.isIdentifier(member.node.id) ? member.node.id.name : member.node.id.value,
          expressionValue(child(member, "initializer"), next),
        );
      }
      return { kind: EUsageValueKind.Object, enum: true, properties };
    }
    if (path.isClassDeclaration()) {
      const properties = new Map<string, TUsageValue>();
      for (const member of children(child(path, "body"), "body")) {
        if (member.isClassMethod({ kind: "constructor" }))
          properties.set("constructor", expressionValue(member, next));
        if (member.isClassProperty() && t.isIdentifier(member.node.key)) {
          const annotation = child(member, "typeAnnotation");
          if (annotation.node) properties.set(member.node.key.name, typeValue(annotation, next));
        }
      }
      return { kind: EUsageValueKind.Object, properties };
    }
    if (path.isThisExpression()) {
      const owner = path.findParent((parent) => parent.isClassDeclaration());
      return owner ? this.evaluate(owner, next, depth + 1) : UNKNOWN;
    }
    if (
      path.isAwaitExpression() ||
      path.isTSNonNullExpression() ||
      path.isParenthesizedExpression()
    ) {
      return this.evaluate(
        path.get(path.isAwaitExpression() ? "argument" : "expression") as TUsagePath,
        next,
        depth + 1,
      );
    }
    if (path.isTSAsExpression() || path.isTSTypeAssertion() || path.isTSSatisfiesExpression()) {
      const annotation = child(path, "typeAnnotation");
      const declared = this.type(annotation, next, depth + 1);
      const value = this.evaluate(child(path, "expression"), next, depth + 1);
      return value.kind === EUsageValueKind.Unknown && declared.kind !== EUsageValueKind.Reference
        ? declared
        : value;
    }
    if (path.isConditionalExpression())
      return unionValue([
        expressionValue(child(path, "consequent"), next),
        expressionValue(child(path, "alternate"), next),
      ]);
    if (path.isLogicalExpression())
      return path.node.operator === "&&"
        ? expressionValue(child(path, "right"), next)
        : unionValue([
            expressionValue(child(path, "left"), next),
            expressionValue(child(path, "right"), next),
          ]);
    if (path.isTemplateLiteral()) {
      const expressions = children(path, "expressions");
      return this.concatenate(
        path.node.quasis.flatMap((part, index) => [
          textValue(part.value.cooked ?? part.value.raw),
          ...(expressions[index] ? [expressionValue(expressions[index], next)] : []),
        ]),
        depth + 1,
      );
    }
    if (path.isBinaryExpression({ operator: "+" }))
      return this.concatenate(
        [expressionValue(child(path, "left"), next), expressionValue(child(path, "right"), next)],
        depth + 1,
      );
    if (path.isArrayExpression())
      return {
        kind: EUsageValueKind.Array,
        elements: children(path, "elements")
          .filter((item) => item.node)
          .flatMap((item) =>
            item.isSpreadElement()
              ? this.alternatives(
                  this.evaluate(child(item, "argument"), next, depth + 1),
                  depth + 1,
                ).flatMap((value) =>
                  value.kind === EUsageValueKind.Array ? value.elements : [value],
                )
              : [expressionValue(item, next)],
          ),
      };
    if (path.isNewExpression() && t.isIdentifier(path.node.callee, { name: "Set" })) {
      const first = children(path, "arguments")[0];
      return first ? this.evaluate(first, next, depth + 1) : UNKNOWN;
    }
    if (path.isNewExpression() && t.isIdentifier(path.node.callee, { name: "Map" })) {
      const argument = children(path, "arguments")[0];
      const collection = argument ? this.evaluate(argument, next, depth + 1) : UNKNOWN;
      const properties = new Map<string, TUsageValue>();
      const parameters = child(path, "typeParameters");
      const valueType = parameters.node ? children(parameters, "params")[1] : undefined;
      if (valueType) properties.set("*", typeValue(valueType, next));
      for (const entry of this.alternatives(
        this.property(collection, undefined, depth + 1),
        depth + 1,
      )) {
        if (entry.kind !== EUsageValueKind.Array) continue;
        const keys = this.strings(entry.elements[0] ?? UNKNOWN, depth + 1);
        for (const key of keys.length ? keys : ["*"])
          properties.set(key, entry.elements[1] ?? UNKNOWN);
      }
      return { kind: EUsageValueKind.Object, map: true, properties };
    }
    if (path.isObjectExpression()) {
      const properties = new Map<string, TUsageValue>();
      for (const property of children(path, "properties")) {
        if (property.isSpreadElement()) {
          for (const value of this.alternatives(
            this.evaluate(child(property, "argument"), next, depth + 1),
            depth + 1,
          )) {
            if (value.kind === EUsageValueKind.Object)
              for (const entry of value.properties) properties.set(...entry);
          }
        } else if (property.isObjectProperty() || property.isObjectMethod()) {
          const keys = property.node.computed
            ? this.strings(this.evaluate(child(property, "key"), next, depth + 1), depth + 1)
            : [
                t.isIdentifier(property.node.key)
                  ? property.node.key.name
                  : t.isStringLiteral(property.node.key)
                    ? property.node.key.value
                    : "",
              ];
          for (const key of keys)
            properties.set(
              key,
              property.isObjectMethod()
                ? { kind: EUsageValueKind.Function, path: property, context: next }
                : expressionValue(child(property, "value"), next),
            );
        }
      }
      return { kind: EUsageValueKind.Object, properties };
    }
    if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      const keys = path.node.computed
        ? this.strings(this.evaluate(child(path, "property"), next, depth + 1), depth + 1)
        : t.isIdentifier(path.node.property)
          ? [path.node.property.name]
          : [];
      return this.property(
        this.evaluate(child(path, "object"), next, depth + 1),
        keys.length ? keys : undefined,
        depth + 1,
      );
    }
    if (path.isCallExpression() || path.isOptionalCallExpression())
      return this.call(path, next, depth + 1);
    return UNKNOWN;
  }
}
