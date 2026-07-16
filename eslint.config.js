import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "src/gen/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The SDK deliberately re-exports protobuf-generated symbols and passes
      // through dynamically-typed wire payloads; `any` is a pragmatic escape
      // hatch at those boundaries rather than a style smell.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Public config types are declared as empty interfaces extending a single
      // transport type so the SDK exposes a stable, extensible public name.
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],
    },
  },
);
