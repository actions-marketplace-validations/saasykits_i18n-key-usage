import { keyName, type NodePath, type TNodeOf } from "../ast/path";
import type { UsageEvaluator } from "./evaluator";
import { child, children } from "./paths";
import type { TUsagePath } from "./types";
import { EUsageFactory, EUsageValueKind, type IUsageContext, type TUsageValue } from "./types";
import { MAX_EVALUATION_DEPTH, textValue, typeValue, UNKNOWN, unionValue } from "./values";

function callableType(
  evaluator: UsageEvaluator,
  path: NodePath<TNodeOf<"TSFunctionType" | "TSCallSignatureDeclaration" | "TSMethodSignature">>,
  context: IUsageContext,
  depth: number,
): TUsageValue {
  const parameters = children(path, "params").map((parameter) =>
    typeValue(child(parameter, "typeAnnotation"), context),
  );
  if (evaluator.resolve(parameters[0] ?? UNKNOWN, depth + 1).kind === EUsageValueKind.Reference)
    return { kind: EUsageValueKind.Translator, namespaces: textValue("") };
  if (!evaluator.references(child(path, "returnType"), context)) return UNKNOWN;
  return {
    kind: EUsageValueKind.Signature,
    parameters,
    returns: typeValue(child(path, "returnType"), context),
  };
}

export function evaluateType(
  evaluator: UsageEvaluator,
  path: TUsagePath,
  context: IUsageContext,
  depth: number,
): TUsageValue {
  if (depth > MAX_EVALUATION_DEPTH) return UNKNOWN;
  if (path.is("TSTypeAnnotation") || path.is("TSTypeAliasDeclaration")) {
    return evaluator.type(child(path, "typeAnnotation"), context, depth + 1);
  }
  if (path.is("TSParenthesizedType")) {
    return evaluator.type(child(path, "typeAnnotation"), context, depth + 1);
  }
  if (path.is("TSLiteralType"))
    return evaluator.evaluate(child(path, "literal"), context, depth + 1);
  if (path.is("TSNullKeyword") || path.is("TSUndefinedKeyword") || path.is("TSNeverKeyword")) {
    return { kind: EUsageValueKind.Union, values: [] };
  }
  if (path.is("TSUnionType") || path.is("TSIntersectionType")) {
    const values = children(path, "types").map((item) => typeValue(item, context));
    if (path.is("TSUnionType")) return unionValue(values);
    const properties = new Map<string, TUsageValue>();
    for (const value of values) {
      const resolved = evaluator.resolve(value, depth + 1);
      if (resolved.kind === EUsageValueKind.Object)
        for (const entry of resolved.properties) properties.set(...entry);
      if (resolved.kind === EUsageValueKind.Translator) return resolved;
    }
    return { kind: EUsageValueKind.Object, properties };
  }
  if (path.is("TSArrayType")) {
    return {
      kind: EUsageValueKind.Array,
      elements: [typeValue(child(path, "elementType"), context)],
    };
  }
  if (path.is("TSTupleType")) {
    return {
      kind: EUsageValueKind.Array,
      elements: children(path, "elementTypes").map((item) => typeValue(item, context)),
    };
  }
  if (path.is("TSTypeQuery")) {
    return evaluator.evaluate(child(path, "exprName"), context, depth + 1);
  }
  if (path.is("TSTypeOperator")) {
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
  if (path.is("TSIndexedAccessType")) {
    const value = evaluator.type(child(path, "objectType"), context, depth + 1);
    const index = child(path, "indexType");
    return evaluator.property(
      value,
      index.is("TSNumberKeyword")
        ? undefined
        : evaluator.strings(evaluator.type(index, context, depth + 1), depth + 1),
      depth + 1,
    );
  }
  if (
    path.is("TSFunctionType") ||
    path.is("TSCallSignatureDeclaration") ||
    path.is("TSMethodSignature")
  ) {
    return callableType(evaluator, path, context, depth);
  }
  if (path.is("TSInterfaceDeclaration") || path.is("TSTypeLiteral")) {
    const members = path.is("TSInterfaceDeclaration")
      ? children(child(path, "body"), "body")
      : children(path, "members");
    const properties = new Map<string, TUsageValue>();
    if (path.is("TSInterfaceDeclaration")) {
      for (const extension of children(path, "extends")) {
        const base = evaluator.evaluate(child(extension, "expression"), context, depth + 1);
        const resolved = evaluator.resolve(base, depth + 1);
        if (resolved.kind === EUsageValueKind.Object)
          for (const entry of resolved.properties) properties.set(...entry);
      }
    }
    for (const member of members) {
      if (member.is("TSCallSignatureDeclaration")) {
        const fn = callableType(evaluator, member, context, depth);
        if (fn.kind === EUsageValueKind.Translator) return fn;
      }
      const node = member.node;
      if (node?.type === "TSMethodSignature") {
        const key = keyName(node.key);
        if (key !== undefined) properties.set(key, typeValue(member, context));
      }
      if (node?.type !== "TSPropertySignature") continue;
      const annotation = child(member, "typeAnnotation");
      if (!annotation.node) continue;
      const key = keyName(node.key);
      if (key !== undefined) properties.set(key, typeValue(annotation, context));
    }
    return { kind: EUsageValueKind.Object, properties };
  }
  if (path.is("TSTypeReference")) {
    const name = child(path, "typeName");
    if (!name.is("Identifier")) return UNKNOWN;
    if (
      name.node.name === "TMessageKey" &&
      evaluator.project.relative(context.module.file) === "src/i18n/i18n.types.ts"
    )
      return { kind: EUsageValueKind.Reference };
    const parameters = child(path, "typeArguments");
    const args = parameters.node ? children(parameters, "params") : [];
    const first = args[0];
    if (["Promise", "Awaited"].includes(name.node.name))
      return first ? evaluator.type(first, context, depth + 1) : UNKNOWN;
    if (name.node.name === "Record") {
      const second = args[1];
      return second
        ? {
            kind: EUsageValueKind.Object,
            properties: new Map([["*", typeValue(second, context)]]),
          }
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
      if (!parent.isFunction() && !parent.is("TSTypeAliasDeclaration")) continue;
      const parameters = child(parent, "typeParameters");
      if (!parameters.node || !parameters.is("TSTypeParameterDeclaration")) continue;
      const symbol = name.node.name;
      const parameter = children(parameters, "params").find(
        (item) => item.is("TSTypeParameter") && item.node.name.name === symbol,
      );
      if (parameter?.is("TSTypeParameter") && parameter.node.constraint)
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
