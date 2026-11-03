import type { TUsagePath } from "./types";

export function child(path: TUsagePath, key: string): TUsagePath {
  const value = path.get(key) as TUsagePath | TUsagePath[];
  if (Array.isArray(value)) throw new Error(`Expected a single AST child: ${path.type}.${key}`);
  return value;
}

export function children(path: TUsagePath, key: string): TUsagePath[] {
  const value = path.get(key) as TUsagePath | TUsagePath[];
  if (Array.isArray(value)) return value;
  if (!value.node) return [];
  throw new Error(`Expected AST children: ${path.type}.${key}`);
}
