// Flat ESLint config for the whole monorepo (ESLint 9 + typescript-eslint 8).
// Plain TS for protocol/core/relay, plus React-hooks rules scoped to the
// desktop renderer. Auto-discovered by each package's `eslint src` invocation.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/src-tauri/target/**",
      "**/src-tauri/gen/**",
      "**/*.config.{js,ts}",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-side packages: relay + protocol + core.
    files: ["apps/relay/**/*.ts", "packages/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Relay is a server: flag stray console use so intentional dev logging
    // must be explicitly opted in (see the disable directive in mail.ts).
    files: ["apps/relay/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Desktop renderer (browser + React).
    files: ["apps/desktop/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Shared rule tweaks. Allow intentionally-unused args prefixed with _.
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
