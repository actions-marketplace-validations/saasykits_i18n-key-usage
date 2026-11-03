import { envName, readOverrides, splitList } from "../src/overrides";

describe("overrides", () => {
  it("names environment variables after config keys", () => {
    expect(envName("messages")).toBe("I18N_KEY_USAGE_MESSAGES");
    expect(envName("literalKeyPrefixes")).toBe("I18N_KEY_USAGE_LITERAL_KEY_PREFIXES");
  });

  it("splits lists on commas and newlines but not inside glob braces", () => {
    expect(splitList("src/**/*.{ts,tsx}, app/**\n lib/*.ts\n")).toEqual([
      "src/**/*.{ts,tsx}",
      "app/**",
      "lib/*.ts",
    ]);
  });

  it("parses symbol references, key functions and families", () => {
    expect(
      readOverrides(
        {
          "key-type": ["src/i18n/types.ts#TMessageKey"],
          "key-function": ["src/i18n/translate.ts#translateMessage:1"],
          family: ["orders.status.{{EOrderStatus}}"],
        },
        {},
      ),
    ).toEqual({
      keyTypes: [{ file: "src/i18n/types.ts", export: "TMessageKey" }],
      keyFunctions: [{ file: "src/i18n/translate.ts", export: "translateMessage", argument: 1 }],
      families: ["orders.status.{{EOrderStatus}}"],
    });
  });

  it("prefers flags over environment variables and ignores empty variables", () => {
    expect(
      readOverrides(
        { include: ["src/**"] },
        {
          I18N_KEY_USAGE_INCLUDE: "lib/**",
          I18N_KEY_USAGE_MESSAGES: "messages/en.json",
          I18N_KEY_USAGE_EXCLUDE: "  ",
        },
      ),
    ).toEqual({ include: ["src/**"], messages: "messages/en.json" });
  });

  it("rejects malformed symbol references", () => {
    expect(() => readOverrides({}, { I18N_KEY_USAGE_KEY_TYPES: "src/types.ts" })).toThrow(
      'Invalid I18N_KEY_USAGE_KEY_TYPES value "src/types.ts", expected <file#export>',
    );
  });
});
