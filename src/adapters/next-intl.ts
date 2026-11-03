import { EUsageFactory, type II18nAdapter } from "../analyzer/types";

const FACTORIES = {
  useTranslations: EUsageFactory.Translations,
  getTranslations: EUsageFactory.Translations,
  createTranslator: EUsageFactory.Translator,
  useMessages: EUsageFactory.Messages,
  getMessages: EUsageFactory.Messages,
};

export const NEXT_INTL_ADAPTER: II18nAdapter = {
  name: "next-intl",
  factories: { "next-intl": FACTORIES, "next-intl/server": FACTORIES },
  namespaceOption: "namespace",
  keyMethods: ["rich", "markup"],
  rawMethods: ["raw"],
  probeMethods: ["has"],
};
