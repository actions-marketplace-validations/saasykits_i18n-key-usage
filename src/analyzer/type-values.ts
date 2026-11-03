import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { UsageEvaluator } from "./evaluator";
import { child, children } from "./paths";
import type { TUsagePath } from "./types";
import {
  EUsageFactory,
  EUsageValueKind,
  type IUsageContext,
  type TUsageValue,
} from "./types";
import { MAX_EVALUATION_DEPTH, textValue, typeValue, UNKNOWN, unionValue } from "./values";

function callableType(
  evaluator: UsageEvaluator,
  path: NodePath<t.TSFunctionType | t.TSCallSignatureDeclaration | t.TSMethodSignature>,
  context: IUsageContext,
  depth: number,
): TUsageValue {
  const parameters = children(path, "parameters").map((parameter) =>
    typeValue(child(parameter, "typeAnnotation"), context),
  );
  if (evaluator.resolve(parameters[0] ?? UNKNOWN, depth + 1).kind === EUsageValueKind.Reference)
    return { kind: EUsageValueKind.Translator, namespaces: textValue("") };
  if (!evaluator.references(child(path, "typeAnnotation"), context)) return UNKNOWN;
  return {
    kind: EUsageValueKind.Signature,
    parameters,
    returns: typeValue(child(path, "typeAnnotation"), context),
  };
}

export function evaluateType(
  evaluator: UsageEvaluator,
  path: TUsagePath,
  context: IUsageContext,
  depth: number,
): TUsageValue {
  if (depth > MAX_EVALUATION_DEPTH) return UNKNOWN;
  if (path.isTSTypeAnnotation() || path.isTSTypeAliasDeclaration()) {
    return evaluator.type(child(path, "typeAnnotation"), context, depth + 1);
  }
  if (path.isTSParenthesizedType()) {
    return evaluator.type(child(path, "typeAnnotation"), context, depth + 1);
  }
  if (path.isTSLiteralType()) return evaluator.evaluate(child(path, "literal"), context, depth + 1);
  if (path.isTSNullKeyword() || path.isTSUndefinedKeyword() || path.isTSNeverKeyword()) {
    return { kind: EUsageValueKind.Union, values: [] };
  }
  if (path.isTSUnionType() || path.isTSIntersectionType()) {
    const values = children(path, "types").map((item) => typeValue(item, context));
    if (path.isTSUnionType()) return unionValue(values);
    const properties = new Map<string, TUsageValue>();
    for (const value of values) {
      const resolved = evaluator.resolve(value, depth + 1);
      if (resolved.kind === EUsageValueKind.Object)
        for (const entry of resolved.properties) properties.set(...entry);
      if (resolved.kind === EUsageValueKind.Translator) return resolved;
    }
    return { kind: EUsageValueKind.Object, properties };
  }
  if (path.isTSArrayType()) {
    return {
      kind: EUsageValueKind.Array,
      elements: [typeValue(child(path, "elementType"), context)],
    };
  }
  if (path.isTSTupleType()) {
    return {
      kind: EUsageValueKind.Array,
      elements: children(path, "elementTypes").map((item) => typeValue(item, context)),
    };
  }
  if (path.isTSTypeQuery()) {
    return evaluator.evaluate(child(path, "exprName"), context, depth + 1);
  }
  if (path.isTSTypeOperator()) {
    const value = evaluator.type(child(path, "typeAnnotation"), context, depth + 1);
    if (path.node.operator !== "keyof") return value;
    return unionValue(
      evaluator
        .alternatives(value, depth + 1)
        .flatMap((item) =>
          item.kind === EUsageValueKind.Object
            ? [...item.properties.keys()].filter((key) => key !== "*").map(textValue)
            : [],
        ),
    );
  }
  if (path.isTSIndexedAccessType()) {
    const value = evaluator.type(child(path, "objectType"), context, depth + 1);
    const index = child(path, "indexType");
    return evaluator.property(
      value,
      index.isTSNumberKeyword()
        ? undefined
        : evaluator.strings(evaluator.type(index, context, depth + 1), depth + 1),
      depth + 1,
    );
  }
  if (
    path.isTSFunctionType() ||
    path.isTSCallSignatureDeclaration() ||
    path.isTSMethodSignature()
  ) {
    return callableType(evaluator, path, context, depth);
  }
  if (path.isTSInterfaceDeclaration() || path.isTSTypeLiteral()) {
    const members = path.isTSInterfaceDeclaration()
      ? children(child(path, "body"), "body")
      : children(path, "members");
    const properties = new Map<string, TUsageValue>();
    if (path.isTSInterfaceDeclaration()) {
      for (const extension of path.node.extends ? children(path, "extends") : []) {
        const base = evaluator.evaluate(child(extension, "expression"), context, depth + 1);
        const resolved = evaluator.resolve(base, depth + 1);
        if (resolved.kind === EUsageValueKind.Object)
          for (const entry of resolved.properties) properties.set(...entry);
      }
    }
    for (const member of members) {
      if (member.isTSCallSignatureDeclaration()) {
        const fn = callableType(evaluator, member, context, depth);
        if (fn.kind === EUsageValueKind.Translator) return fn;
      }
      if (member.isTSMethodSignature()) {
        const key = t.isIdentifier(member.node.key)
          ? member.node.key.name
          : t.isStringLiteral(member.node.key)
            ? member.node.key.value
            : undefined;
        if (key !== undefined) properties.set(key, typeValue(member, context));
      }
      if (!member.isTSPropertySignature()) continue;
      const annotation = child(member, "typeAnnotation");
      if (!annotation.node) continue;
      const key = t.isIdentifier(member.node.key)
        ? member.node.key.name
        : t.isStringLiteral(member.node.key)
          ? member.node.key.value
          : undefined;
      if (key !== undefined) properties.set(key, typeValue(annotation, context));
    }
    return { kind: EUsageValueKind.Object, properties };
  }
  if (path.isTSTypeReference()) {
    const name = child(path, "typeName");
    if (!name.isIdentifier()) return UNKNOWN;
    if (
      name.node.name === "TMessageKey" &&
      evaluator.project.relative(context.module.file) === "src/i18n/i18n.types.ts"
    )
      return { kind: EUsageValueKind.Reference };
    const parameters = child(path, "typeParameters");
    const args = parameters.node ? children(parameters, "params") : [];
    const first = args[0];
    if (["Promise", "Awaited"].includes(name.node.name))
      return first ? evaluator.type(first, context, depth + 1) : UNKNOWN;
    if (name.node.name === "Record") {
      const second = args[1];
      return second
        ? { kind: EUsageValueKind.Object, properties: new Map([["*", typeValue(second, context)]]) }
        : UNKNOWN;
    }
    if (
      ["Partial", "Required", "Readonly", "NonNullable", "Pick", "Omit"].includes(name.node.name)
    ) {
      return first ? evaluator.type(first, context, depth + 1) : UNKNOWN;
    }
    if (name.node.name === "Extract" || name.node.name === "Exclude") {
      return first ? evaluator.type(first, context, depth + 1) : UNKNOWN;
    }
    if (name.node.name === "ReturnType" && first) {
      const fn = evaluator.resolve(evaluator.type(first, context, depth + 1), depth + 1);
      if (
        fn.kind === EUsageValueKind.Factory &&
        [EUsageFactory.Translations, EUsageFactory.Translator].includes(fn.factory)
      ) {
        return { kind: EUsageValueKind.Translator, namespaces: textValue("") };
      }
      return evaluator.resolve(evaluator.invoke(fn, [], depth + 1), depth + 1);
    }
    for (let parent: TUsagePath | null = path.parentPath; parent; parent = parent.parentPath) {
      if (!parent.isFunction() && !parent.isTSTypeAliasDeclaration()) continue;
      const parameters = child(parent, "typeParameters");
      if (!parameters.node || !parameters.isTSTypeParameterDeclaration()) continue;
      const symbol = name.node.name;
      const parameter = children(parameters, "params").find(
        (item) => item.isTSTypeParameter() && item.node.name === symbol,
      );
      if (parameter?.isTSTypeParameter() && parameter.node.constraint)
        return evaluator.type(child(parameter, "constraint"), context, depth + 1);
    }
    const value = evaluator.evaluate(name, context, depth + 1);
    const resolved = evaluator.resolve(value, depth + 1);
    return resolved.kind === EUsageValueKind.Object && resolved.enum
      ? unionValue([...resolved.properties.values()])
      : value;
  }
  return UNKNOWN;
}
