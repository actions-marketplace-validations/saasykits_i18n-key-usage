import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { checkMessageUsage } from "./check";
import { DYNAMIC_MESSAGE_FAMILIES, RETAINED_MESSAGES } from "./config";

function catalogKeys(value: unknown, prefix: string): string[] {
	if (typeof value === "string") return [prefix];
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`Invalid message: ${prefix}`);
	return Object.entries(value).flatMap(([key, message]) =>
		catalogKeys(message, `${prefix}.${key}`),
	);
}

const root = process.cwd();
const directory = resolve(root, "messages/en");
const keys = readdirSync(directory)
	.filter((file) => file.endsWith(".json"))
	.flatMap((file) =>
		catalogKeys(
			JSON.parse(readFileSync(resolve(directory, file), "utf8")),
			file.slice(0, -".json".length),
		),
	);
const result = checkMessageUsage({
	root,
	keys,
	families: DYNAMIC_MESSAGE_FAMILIES,
	retained: RETAINED_MESSAGES,
	onFile: process.argv.includes("--progress")
		? (file, index) => {
				process.stderr.write(`${index}: ${file}\n`);
			}
		: undefined,
});
if (process.argv.includes("--json")) {
	process.stdout.write(
		`${JSON.stringify({ ...result, used: [...result.used].sort() }, null, 2)}\n`,
	);
} else {
	for (const key of result.unused)
		process.stdout.write(`Unused message: ${key}\n`);
	for (const diagnostic of [...result.missing, ...result.unresolved])
		process.stdout.write(
			`${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}\n  ${diagnostic.expression}\n`,
		);
	for (const message of result.invalidDeclarations)
		process.stdout.write(`${message}\n`);
	process.stdout.write(
		`Scanned ${result.files} files: ${result.used.size}/${keys.length} keys referenced, ${result.unused.length} unused, ${result.missing.length} missing, ${result.unresolved.length} unresolved.\n`,
	);
}
process.exitCode =
	result.unused.length ||
	result.missing.length ||
	result.unresolved.length ||
	result.invalidDeclarations.length
		? 1
		: 0;
