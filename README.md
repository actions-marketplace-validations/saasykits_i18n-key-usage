# i18n-key-usage

Find unused, missing and unresolved i18n message keys in TypeScript projects.

Most key checkers grep each file for `t("…")` calls. That misses keys stored in constants, passed
through helpers, typed as a key union or built from an enum, so they report many used keys as
unused. `i18n-key-usage` evaluates how keys flow through your code instead:
- **Across modules:** imports, re-exports and `export *`, plus tsconfig path aliases.
- **Through values:** constants, objects, maps, arrays, spreads, ternaries, template literals,
  destructuring, function parameters and return values, `Array.map` callbacks and React state.
- **Through types:** values typed as your key type (e.g. `TMessageKey`) count as key references
  wherever they are used.
- **Strict about dynamic keys:** a key it cannot resolve to a finite set is reported, with its
  location, instead of silently counting a whole namespace as used. Families such as
  `status.*` are declared against the enum that lists their values, and stale declarations fail.

Parsing uses [oxc](https://oxc.rs). A 3,200-file Next.js app with 5,400 keys checks in about
25 seconds.

**Supported libraries:** [next-intl](https://next-intl.dev). The analyzer core is
library-agnostic; adapters for other libraries are welcome (see [Adapters](#adapters)).

## Quick start

```bash
npm install --save-dev i18n-key-usage
```

Create `i18n-key-usage.config.json` in the project root:

```json
{
  "$schema": "./node_modules/i18n-key-usage/schema.json",
  "messages": "messages/en.json"
}
```

Run it:

```bash
npx i18n-key-usage
```

```text
Unused message: home.subtitle (messages/en.json)
src/app/page.tsx:12: Unknown message key: home.titel
  t("titel")
Scanned 214 files: 380/381 keys referenced, 1 unused, 1 missing, 0 unresolved.
```

Exit codes: `0` clean, `1` problems found, `2` configuration or parse error.

## GitHub Action

```yaml
name: i18n
on: pull_request
jobs:
  keys:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - uses: iamtouha/i18n-key-usage@v1
        with:
          config: i18n-key-usage.config.json # default
          working-directory: . # project root, e.g. apps/web in a monorepo
```

Findings appear as annotations on the pull request and a table in the job summary. The action runs
the npm release matching its tag (`@v1` runs the latest 1.x), so no install step is needed. Set
`version` to pin an exact release.

## What it reports

| Problem             | Meaning                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unused              | A catalog key that no application code references.                                                                                                                                  |
| Missing             | Code references a key that the source catalog does not define.                                                                                                                      |
| Unresolved          | A dynamic key whose possible values cannot be determined, e.g. `t(row.labelKey)` where `labelKey` is an arbitrary string. Type it as your key type, narrow it, or declare a family. |
| Invalid declaration | A family or retained key that is malformed, unused or stale.                                                                                                                        |

Tests, fixtures, generated files and catalog imports (e.g. passing `messages` to a provider) do not
count as usage.

## Configuration

All paths are relative to the project root. Only `messages` is required. The full schema ships as
[`schema.json`](schema.json).

| Option                | Default                                                 | Description                                                                                                                                 |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`            |                                                         | Source-locale catalog: a JSON file, or a directory with one JSON file per top-level namespace (`messages/en/common.json` holds `common.*`). |
| `library`             | `"next-intl"`                                           | Which adapter recognizes translators.                                                                                                       |
| `include`             | `["**/*.{ts,tsx}"]`                                     | Sources to scan.                                                                                                                            |
| `exclude`             | tests, fixtures, `*.d.ts`, `node_modules`, build output | Globs removed from `include`.                                                                                                               |
| `catalogs`            | `["messages/*"]`                                        | Catalog files or directories. Importing one is a catalog read, not usage.                                                                   |
| `tsconfig`            | `"tsconfig.json"`                                       | Where import aliases (`compilerOptions.paths`) come from.                                                                                   |
| `keyTypes`            | `[]`                                                    | Types whose values are message keys, e.g. `{ "file": "src/i18n/types.ts", "export": "TMessageKey" }`.                                       |
| `translatorTypes`     | `[]`                                                    | Types whose values are translators, e.g. an `ITranslator` interface with a call signature.                                                  |
| `messageLoaders`      | `[]`                                                    | Functions that return the whole catalog. Member reads on the result count as usage.                                                         |
| `keyFunctions`        | `[]`                                                    | Functions whose argument at `argument` (zero-based) is a key, e.g. `translateMessage(t, key)`.                                              |
| `keyProperties`       | `[]`                                                    | Object properties whose string values are keys, e.g. `["labelKey", "titleKey"]`.                                                            |
| `validationLibraries` | `[]`                                                    | Modules whose call arguments may be keys, e.g. `["zod"]` for `z.string().min(1, "errors.required")`.                                        |
| `literalKeyPrefixes`  | `[]`                                                    | Any string literal with one of these prefixes is a key, e.g. `["errors."]` for error codes thrown on the server.                            |
| `families`            | `[]`                                                    | Dynamic key families, see below.                                                                                                            |
| `retained`            | `[]`                                                    | Keys to keep although nothing references them, each with a `reason`.                                                                        |

### Dynamic key families

When keys are built at runtime from a finite set of values, declare the family and point at the
code that lists the values:

```json
{
  "families": [
    {
      "pattern": "orders.status.*",
      "source": "src/orders/order-status.ts",
      "export": "EOrderStatus",
      "reason": "Order rows render the status enum."
    }
  ]
}
```

`export` can be an enum or a constant object; the family's keys are built from its values. Only those
keys count as used, so a removed enum member makes its key unused. A family that no code matches
anymore is reported as stale.

Families are only needed when the analyzer cannot see the values. A template such as
``t(`status.${status}`)`` resolves on its own when `status` is typed as an enum or a union of string
literals.

Prefer typed keys over families where you can. A value typed as one of your `keyTypes` is checked at
every place it is produced, with no declaration needed:

```ts
import type { TMessageKey } from "@/i18n/types";

export const STATUS_LABELS: Record<EOrderStatus, TMessageKey> = {
  [EOrderStatus.Open]: "orders.status.open",
  [EOrderStatus.Closed]: "orders.status.closed",
};
```

## Programmatic API

```ts
import { checkMessageUsage, createReport, loadConfig } from "i18n-key-usage";

const { options, keyFiles } = loadConfig(process.cwd());
const report = createReport(checkMessageUsage(options), keyFiles);
```

`checkMessageUsage` also accepts in-memory `sources`, which is how the test suite runs.

## Adapters

An adapter tells the analyzer which imports create translators and catalogs
([`src/adapters/next-intl.ts`](src/adapters/next-intl.ts)):

```ts
export const NEXT_INTL_ADAPTER: II18nAdapter = {
  name: "next-intl",
  factories: { "next-intl": FACTORIES, "next-intl/server": FACTORIES },
  namespaceOption: "namespace",
  keyMethods: ["rich", "markup"],
  rawMethods: ["raw"],
  probeMethods: ["has"],
};
```

Libraries with the same model (a factory returns a translator scoped to a dot-separated namespace)
fit by adding an adapter and registering it in [`src/adapters/index.ts`](src/adapters/index.ts).
Libraries with other key syntax, such as i18next's `ns:key` or `keyPrefix`, need small core
changes. Issues and pull requests are welcome.

## Development

```bash
pnpm install
pnpm test
pnpm build
```

`pnpm check` lints and formats with Biome, `pnpm typecheck` runs TypeScript and `pnpm schema`
regenerates `schema.json` after config changes.

## License

[MIT](LICENSE)
