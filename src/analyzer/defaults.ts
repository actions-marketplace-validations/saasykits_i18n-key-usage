export const DEFAULT_INCLUDE = ["**/*.{ts,tsx}"];

export const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/*.d.ts",
  "**/*.{test,spec,generated}.{ts,tsx}",
  "**/{__tests__,__fixtures__,test,tests,testing}/**",
];

export const DEFAULT_CATALOGS = ["messages/*"];

/** A literal that looks like a dotted message key, e.g. `common.save`. */
export const KEY_LITERAL = /^[a-zA-Z]+\.[a-zA-Z0-9_.]+$/;
