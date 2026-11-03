import type { TUsagePath } from "./types";

import { EUsageValueKind, type IUsageContext, type TUsageValue } from "./types";

export const UNKNOWN: TUsageValue = { kind: EUsageValueKind.Unknown };
export const MESSAGE_REFERENCE: TUsageValue = {
	kind: EUsageValueKind.Reference,
};
export const MAX_MODULE_CACHE = 512;
export const MAX_EVALUATION_DEPTH = 96;
export const MAX_ALTERNATIVES = 1024;

export function textValue(text: string): TUsageValue {
	return { kind: EUsageValueKind.Text, parts: [text] };
}

export function expressionValue(
	path: TUsagePath,
	context: IUsageContext,
): TUsageValue {
	return { kind: EUsageValueKind.Expression, path, context };
}

export function typeValue(
	path: TUsagePath,
	context: IUsageContext,
): TUsageValue {
	return { kind: EUsageValueKind.Type, path, context };
}

export function unionValue(values: TUsageValue[]): TUsageValue {
	const flat = values.flatMap((value) =>
		value.kind === EUsageValueKind.Union ? value.values : [value],
	);
	return flat.length === 1
		? (flat[0] ?? UNKNOWN)
		: { kind: EUsageValueKind.Union, values: flat };
}

export function patternText(parts: (string | null)[]): string {
	return parts.map((part) => part ?? "*").join("");
}

export function isProductionSource(file: string): boolean {
	return (
		/\.(?:ts|tsx)$/.test(file) &&
		!/\.(?:test|spec|generated|d)\.tsx?$/.test(file) &&
		!/(?:^|\/)(?:__tests__|__fixtures__|tests?|testing)(?:\/|$)/.test(file) &&
		!file.startsWith("src/i18n/usage/")
	);
}
