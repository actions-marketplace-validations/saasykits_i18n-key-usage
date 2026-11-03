import { NEXT_INTL_ADAPTER } from "../src/adapters/next-intl";
import { checkMessageUsage } from "../src/analyzer/check";
import type { IUsageOptions, IUsageResult, IUsageSource } from "../src/analyzer/types";

const ROOT = "/project";
const TYPES: IUsageSource = {
  file: "src/i18n/i18n.types.ts",
  code: "export type TMessageKey = string; export interface IMessageRef { key: TMessageKey }",
};
const TRANSLATOR: IUsageSource = {
  file: "src/i18n/translate.ts",
  code: 'import type { TMessageKey } from "./i18n.types"; export interface ITranslator { (key: TMessageKey): string }',
};

/** A project laid out like the one the analyzer was extracted from. */
const PROJECT: Omit<IUsageOptions, "keys"> = {
  root: ROOT,
  include: ["src/**/*.{ts,tsx}"],
  paths: { "@/*": ["src/*"] },
  catalogs: ["messages/en", "messages/bn"],
  adapter: NEXT_INTL_ADAPTER,
  keyTypes: [{ file: "src/i18n/i18n.types.ts", export: "TMessageKey" }],
  translatorTypes: [{ file: "src/i18n/translate.ts", export: "ITranslator" }],
  messageLoaders: [{ file: "src/i18n/messages.ts", export: "loadMessages" }],
  keyFunctions: [{ file: "src/i18n/translate.ts", export: "translateMessage", argument: 1 }],
  keyProperties: ["error", "message", "messageKey", "labelKey", "titleKey", "descriptionKey"],
  validationLibraries: ["zod"],
  literalKeyPrefixes: ["errors."],
};

function check(
  code: string,
  keys: string[],
  sources: IUsageSource[] = [],
  options: Partial<IUsageOptions> = {},
): IUsageResult {
  return checkMessageUsage({
    ...PROJECT,
    keys,
    sources: [TYPES, TRANSLATOR, { file: "src/example.tsx", code }, ...sources],
    ...options,
  });
}

function expectClean(result: IUsageResult) {
  expect({
    unused: result.unused,
    missing: result.missing,
    unresolved: result.unresolved,
    invalidDeclarations: result.invalidDeclarations,
  }).toEqual({
    unused: [],
    missing: [],
    unresolved: [],
    invalidDeclarations: [],
  });
}

describe("message usage", () => {
  it("resolves namespaces, aliases, rich text and optional messages", () => {
    const result = check(
      `
      import { useTranslations as useText } from 'next-intl';
      export function Screen() {
        const text = useText('common.actions');
        const alias = text;
        return [alias('save'), text.rich('cancel', {}), text.has('optional')];
      }
    `,
      [
        "common.actions.save",
        "common.actions.cancel",
        "common.actions.optional",
        "common.actions.unused",
      ],
    );
    expect(result.unused).toEqual(["common.actions.unused"]);
    expect([...result.used].sort()).toEqual([
      "common.actions.cancel",
      "common.actions.optional",
      "common.actions.save",
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("handles Promise.all and inline awaited factories", () => {
    expectClean(
      check(
        `
      import { getTranslations } from 'next-intl/server';
      export async function Screen() {
        const [data, t, root] = await Promise.all([load(), getTranslations('cashbook'), getTranslations()]);
        return [t('title'), root('common.empty'), (await getTranslations('cashbook.presentation'))('transferDescription')];
      }
    `,
        ["cashbook.title", "common.empty", "cashbook.presentation.transferDescription"],
      ),
    );
  });

  it("follows imported maps and hook-returned translators", () => {
    expectClean(
      check(
        `
      import { useScreen } from './screen.hooks';
      import { LABELS } from './labels';
      export function Screen({status}) {
        const { t: text } = useScreen();
        return text(LABELS[status]);
      }
    `,
        ["common.active", "common.archived"],
        [
          {
            file: "src/screen.hooks.ts",
            code: "import { useTranslations } from 'next-intl'; export function useScreen() { const t = useTranslations(); return { t }; }",
          },
          {
            file: "src/labels.ts",
            code: "export const LABELS = { active: 'common.active', archived: 'common.archived' } as const;",
          },
        ],
      ),
    );
  });

  it("resolves finite dynamic namespaces from imported configuration", () => {
    expectClean(
      check(
        `
      import { useTranslations } from 'next-intl';
      import { TARGETS } from './targets';
      export function Screen({kind}) {
        const config = TARGETS[kind];
        const t = useTranslations(config.namespace);
        return t('submit');
      }
    `,
        ["sales.deliver.submit", "sales.return.submit"],
        [
          {
            file: "src/targets.ts",
            code: "export const TARGETS = { delivery: { namespace: 'sales.deliver' }, return: { namespace: 'sales.return' } } as const;",
          },
        ],
      ),
    );
  });

  it("follows destructured translator parameters through interface types", () => {
    expectClean(
      check(
        `
      import type { ITranslator } from './i18n/translate';
      interface IProps { t: ITranslator }
      export function rows({ t }: IProps) { return t('common.empty'); }
    `,
        ["common.empty"],
      ),
    );
  });

  it("collects typed message producers without counting the entire key type", () => {
    const result = check(
      `
      import type { TMessageKey } from './i18n/i18n.types';
      import type { ITranslator } from './i18n/translate';
      const LABELS = { save: 'common.save' } satisfies Record<string, TMessageKey>;
      function read(t: ITranslator, key: TMessageKey) { return t(key); }
      function fail(key: TMessageKey) { throw new Error(key); }
      fail('errors.forbidden');
      const unrelated = 'common.unused';
    `,
      ["common.save", "errors.forbidden", "common.unused"],
    );
    expect(result.unused).toEqual(["common.unused"]);
    expect(result.unresolved).toEqual([]);
  });

  it("expands enum templates in typed server error producers", () => {
    expectClean(
      check(
        `
      import type { TMessageKey } from './i18n/i18n.types';
      import { EEntity } from './entities';
      function fail(key: TMessageKey) { throw new Error(key); }
      function missing(entity: EEntity) { fail(\`errors.notFound.\${entity}\`); }
    `,
        ["errors.notFound.customer", "errors.notFound.product"],
        [
          {
            file: "src/entities.ts",
            code: "export enum EEntity { Customer = 'customer', Product = 'product' }",
          },
        ],
      ),
    );
  });

  it("excludes test, fixture, generated and catalog-only references", () => {
    const result = check(
      "import messages from '../messages/en'; const unrelated = 'common.unused';",
      ["common.unused"],
      [
        {
          file: "src/example.test.ts",
          code: "import { useTranslations } from 'next-intl'; const t = useTranslations(); t('common.unused');",
        },
        {
          file: "src/__fixtures__/example.ts",
          code: "throw new Error('errors.fake');",
        },
        {
          file: "src/server/testing/example.ts",
          code: "throw new Error('errors.fake');",
        },
        {
          file: "src/seed.generated.ts",
          code: "throw new Error('errors.fake');",
        },
      ],
    );
    expect(result.unused).toEqual(["common.unused"]);
    expect(result.missing).toEqual([]);
  });

  it("reports missing keys and unresolved runtime keys", () => {
    const result = check(
      `
      import { useTranslations } from 'next-intl';
      export function Screen({ key }) { const t = useTranslations('common'); return [t('missing'), t(key)]; }
    `,
      ["common.unused"],
    );
    expect(result.missing).toEqual([
      expect.objectContaining({
        file: "src/example.tsx",
        message: "Unknown message key: common.missing",
      }),
    ]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({
        message: "Cannot resolve dynamic message key: common.*",
      }),
    ]);
    expect(result.unused).toEqual(["common.unused"]);
  });

  it("expands declared enum families without exempting an entire namespace", () => {
    const result = check(
      `
      import { useTranslations } from 'next-intl';
      export function Screen({ status }) { const t = useTranslations('common'); return t(\`status.\${status}\`); }
    `,
      ["common.status.active", "common.status.archived", "common.status.unused"],
      [
        {
          file: "src/status.ts",
          code: "export enum EStatus { Active = 'active', Archived = 'archived' }",
        },
      ],
      {
        families: ["common.status.{{EStatus}}"],
      },
    );
    expect(result.unused).toEqual(["common.status.unused"]);
    expect(result.unresolved).toEqual([]);
  });

  it("rejects stale family and retained-key declarations", () => {
    const result = check("", ["common.old"], [], {
      retained: ["common.missing", "common.old", "common.old"],
      families: ["common.status.{{EStatus}}", "common.status.*"],
    });
    expect(result.invalidDeclarations.sort()).toEqual([
      "Invalid dynamic family declaration: common.status.* (use {{ExportName}} placeholders)",
      "Invalid or stale retained key: common.missing",
      "Invalid or stale retained key: common.old",
      "Unused dynamic family declaration: common.status.{{EStatus}}",
    ]);
  });

  it("counts explicit catalog reads and raw objects without counting provider imports", () => {
    const result = check(
      `
      import messages from '../messages/en';
      import { useTranslations } from 'next-intl';
      const provider = { messages };
      const title = messages.meta.title;
      const t = useTranslations('common');
      t.raw('options');
    `,
      ["meta.title", "common.options.save", "common.options.cancel", "common.unused"],
    );
    expect([...result.used].sort()).toEqual([
      "common.options.cancel",
      "common.options.save",
      "meta.title",
    ]);
    expect(result.unused).toEqual(["common.unused"]);
    expect(result.missing).toEqual([]);
  });

  it("follows nullable maps, array spreads and Array.from callbacks", () => {
    expectClean(
      check(
        `
      import { useTranslations } from 'next-intl';
      import type { TMessageKey } from './i18n/i18n.types';
      const BASE = [{ label: 'save' }, { label: 'cancel' }] as const;
      const ITEMS = [...BASE];
      const NOTICE: Record<string, TMessageKey | null> = { none: null, ready: 'common.ready' };
      export function Screen({status}) {
        const t = useTranslations('common');
        const root = useTranslations();
        const labels = ITEMS.map(item => item.label);
        return [Array.from(new Set(labels), key => t(key)), root(NOTICE[status])];
      }
    `,
        ["common.save", "common.cancel", "common.ready"],
      ),
    );
  });

  it("respects literal branch narrowing when building keys", () => {
    expectClean(
      check(
        `
      import { useTranslations } from 'next-intl';
      const FIELDS = ['name', 'quantity'] as const;
      export function Screen() {
        const t = useTranslations('form');
        return FIELDS.map(field => field === 'quantity' ? t('quantityHint') : t(\`\${field}Description\`));
      }
    `,
        ["form.nameDescription", "form.quantityHint"],
      ),
    );
  });

  it("ignores namespace prefixes used for error classification", () => {
    const result = check("export const PREFIX = 'errors.insufficientCredits';", [
      "errors.insufficientCredits.default",
    ]);
    expect(result.unused).toEqual(["errors.insufficientCredits.default"]);
    expect(result.missing).toEqual([]);
  });

  it("does not confuse an unrelated shadowed function with a translator", () => {
    const result = check(`function t(value: string) { return value; } t('common.unused');`, [
      "common.unused",
    ]);
    expect(result.unused).toEqual(["common.unused"]);
    expect(result.missing).toEqual([]);
  });

  it("recognizes nested message references returned by helper functions", () => {
    expectClean(
      check(
        `
      import type { IMessageRef } from './i18n/i18n.types';
      export function hint(whole: boolean): IMessageRef {
        return whole ? { key: 'price.whole' } : { key: 'price.decimals' };
      }
    `,
        ["price.whole", "price.decimals"],
      ),
    );
  });

  it("collects Zod errors and action-state validation messages", () => {
    expectClean(
      check(
        `
      import { z as schema } from 'zod';
      const form = schema.object({
        password: schema.string().min(1, 'auth.required'),
        reason: schema.string({ error: 'form.reasonRequired' }),
      });
      export const state = { message: 'account.mismatch' };
    `,
        ["auth.required", "form.reasonRequired", "account.mismatch"],
      ),
    );
  });

  it("follows type and value re-exports through index files", () => {
    expectClean(
      check(
        `
      import { LABELS } from './labels';
      import type { IContext } from './context';
      export function render({ t }: IContext, status: string) { return t(LABELS[status]); }
    `,
        ["common.ready"],
        [
          {
            file: "src/labels/index.ts",
            code: "export { LABELS } from './labels';",
          },
          {
            file: "src/labels/labels.ts",
            code: "export const LABELS = { ready: 'common.ready' } as const;",
          },
          {
            file: "src/context/index.ts",
            code: "export type { IContext } from './context';",
          },
          {
            file: "src/context/context.ts",
            code: "import type { ITranslator } from '../i18n/translate'; export interface IContext { t: ITranslator }",
          },
        ],
      ),
    );
  });

  it("supports translators created with locale and messages options", () => {
    expectClean(
      check(
        `
      import { createTranslator } from 'next-intl';
      const t = createTranslator({ locale: 'en', messages: {} });
      t('emails.subject');
    `,
        ["emails.subject"],
      ),
    );
  });

  it("collects message references inserted into typed arrays", () => {
    const result = check(
      `
      import type { IMessageRef } from './i18n/i18n.types';
      const notes: IMessageRef[] = [];
      const alias = notes;
      notes.unshift(disabled ? { key: 'notes.disabled' } : { key: 'notes.former' });
      alias.push({ key: 'notes.pushed' });
      notes.splice(0, 1, { key: 'notes.replaced' });
      const batch = [{ key: 'notes.spread' }] as const;
      notes.push(...batch);
      const unrelated = [];
      unrelated.push({ key: 'notes.unused' });
    `,
      [
        "notes.disabled",
        "notes.former",
        "notes.pushed",
        "notes.replaced",
        "notes.spread",
        "notes.unused",
      ],
    );
    expect(result.unused).toEqual(["notes.unused"]);
    expect(result.missing).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("collects typed React state initializers, setters and updater returns", () => {
    const result = check(
      `
      import { useState as useValue } from 'react';
      import type { IMessageRef } from './i18n/i18n.types';
      function Screen() {
        const [status, setStatus] = useValue<IMessageRef | null>(() => ({ key: 'chat.initial' }));
        const update = setStatus;
        update(attachment ? { key: 'chat.reading' } : { key: 'chat.running' });
        setStatus(previous => ready ? { key: 'chat.ready' } : previous);
        setStatus(null);
        const [other, setOther] = useValue<{ key: string } | null>(null);
        setOther({ key: 'chat.unused' });
      }
    `,
      ["chat.initial", "chat.reading", "chat.running", "chat.ready", "chat.unused"],
    );
    expect(result.unused).toEqual(["chat.unused"]);
    expect(result.missing).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("follows inferred async method and callback return types", () => {
    const result = check(
      `
      import type { IAction } from './actions';
      const action: IAction = {
        async currentState(ctx) { return [{ label: { key: 'summary.current' } }]; },
        summarize: async () => ({ key: 'summary.title' }),
        async unrelated() { return { key: 'summary.unused' }; },
      };
      const unrelated = { async currentState() { return { key: 'summary.unused' }; } };
    `,
      ["summary.current", "summary.title", "summary.unused"],
      [
        {
          file: "src/actions.ts",
          code: `
        import type { IMessageRef } from './i18n/i18n.types';
        export interface IAction {
          currentState(ctx: unknown): Promise<{ label: IMessageRef }[]>;
          summarize: () => Promise<IMessageRef>;
          unrelated(): Promise<{ key: string }>;
        }
      `,
        },
      ],
    );
    expect(result.unused).toEqual(["summary.unused"]);
    expect(result.missing).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("reports missing keys in indirect typed producers", () => {
    const result = check(
      `
      import { useState } from 'react';
      import type { IMessageRef } from './i18n/i18n.types';
      const notes: IMessageRef[] = [];
      notes.push({ key: 'notes.missing' });
      const [status, setStatus] = useState<IMessageRef | null>(null);
      setStatus({ key: 'chat.missing' });
      interface IAction { currentState(): Promise<IMessageRef> }
      const action: IAction = { async currentState() { return { key: 'summary.missing' }; } };
    `,
      [],
    );
    expect(result.missing.map(({ message }) => message).sort()).toEqual([
      "Unknown message key: chat.missing",
      "Unknown message key: notes.missing",
      "Unknown message key: summary.missing",
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("reports unresolved keys in indirect typed producers", () => {
    const result = check(
      `
      import { useState } from 'react';
      import type { IMessageRef } from './i18n/i18n.types';
      const notes: IMessageRef[] = [];
      notes.push({ key: runtimeNote });
      const [status, setStatus] = useState<IMessageRef | null>(null);
      setStatus({ key: runtimeStatus });
      interface IAction { currentState(): Promise<IMessageRef> }
      const action: IAction = { async currentState() { return { key: runtimeSummary }; } };
    `,
      [],
    );
    expect(result.missing).toEqual([]);
    expect(result.unresolved.map(({ message }) => message)).toEqual([
      "Cannot resolve dynamic message key: *",
      "Cannot resolve dynamic message key: *",
      "Cannot resolve dynamic message key: *",
    ]);
  });

  it("keeps excluded label-map entries unused after branch narrowing", () => {
    const result = check(
      `
      import { useTranslations } from 'next-intl';
      const LABELS = { all: 'products.all', low: 'products.low' } as const;
      function Screen(kind: 'all' | 'low') {
        const t = useTranslations();
        if (kind === 'all') return null;
        return t(LABELS[kind]);
      }
    `,
      ["products.all", "products.low"],
    );
    expect(result.unused).toEqual(["products.all"]);
    expect([...result.used]).toEqual(["products.low"]);
    expect(result.missing).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("distinguishes callback closures and contextual return shapes", () => {
    expectClean(
      check(
        `
      import type { IMessageRef, TMessageKey } from './i18n/i18n.types';
      function build(key: string) { return () => ({ key }); }
      interface IAction { read(): IMessageRef }
      const first: IAction = { read: build('labels.first') };
      const second: IAction = { read: build('labels.second') };
      const labels = () => ({ primary: 'labels.primary', secondary: 'labels.secondary' });
      const primary: { read(): { primary: TMessageKey } } = { read: labels };
      const secondary: { read(): { secondary: TMessageKey } } = { read: labels };
    `,
        ["labels.first", "labels.second", "labels.primary", "labels.secondary"],
      ),
    );
  });

  it("preserves typed message references through destructured map loops", () => {
    expectClean(
      check(
        `
      import type { IMessageRef } from './i18n/i18n.types';
      interface IField { label: IMessageRef | { text: string } }
      const definition: IField = { label: { key: 'labels.notice' } };
      const known = new Map<string, IField>();
      known.set('notice', definition);
      const result: IField[] = [];
      for (const [field, { label }] of known) result.push({ label });
    `,
        ["labels.notice"],
      ),
    );
  });
  it("resolves templates over enum and string-union typed values without families", () => {
    const result = check(
      `
      import { useTranslations } from 'next-intl';
      enum EStatus { Open = 'open', Closed = 'closed' }
      type TSize = 'small' | 'large';
      export function Row({ status, size }: { status: EStatus; size: TSize }) {
        const t = useTranslations('orders');
        return t(\`status.\${status}\`) + t(\`size.\${size}\`);
      }
      `,
      ["orders.status.open", "orders.status.closed", "orders.size.small", "orders.size.large"],
    );
    expectClean(result);
  });
  it("expands families with several placeholders from unions and constant arrays", () => {
    const result = check(
      `
      import { useTranslations } from 'next-intl';
      export function Cell({ region, status }) {
        const t = useTranslations('orders');
        return t(\`\${region}.\${status}\`);
      }
    `,
      ["orders.eu.open", "orders.eu.closed", "orders.us.open", "orders.us.closed", "orders.title"],
      [
        { file: "src/regions.ts", code: "export const REGIONS = ['eu', 'us'] as const;" },
        { file: "src/status.ts", code: "export type TStatus = 'open' | 'closed';" },
      ],
      { families: ["orders.{{REGIONS}}.{{TStatus}}"] },
    );
    expect(result.unused).toEqual(["orders.title"]);
    expect(result.invalidDeclarations).toEqual([]);
  });

  it("asks for a file when several files export a family's name", () => {
    const code = `
      import { useTranslations } from 'next-intl';
      export function Badge({ status }) { const t = useTranslations('common'); return t(\`status.\${status}\`); }
    `;
    const sources = [
      { file: "src/a/status.ts", code: "export enum EStatus { Open = 'open' }" },
      { file: "src/b/status.ts", code: "export enum EStatus { Closed = 'closed' }" },
    ];
    const ambiguous = check(code, ["common.status.open"], sources, {
      families: ["common.status.{{EStatus}}"],
    });
    expect(ambiguous.invalidDeclarations).toEqual([
      "Dynamic family common.status.{{EStatus}}: EStatus is exported by src/a/status.ts, src/b/status.ts; use {{file#EStatus}}",
    ]);
    const picked = check(code, ["common.status.open"], sources, {
      families: ["common.status.{{src/a/status.ts#EStatus}}"],
    });
    expect(picked.unused).toEqual([]);
    expect(picked.invalidDeclarations).toEqual([]);
  });
});
