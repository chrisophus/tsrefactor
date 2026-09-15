// Lint policy for tsrefactor.
//
// The division of labour mirrors the one this repository recommends for Go:
// off-the-shelf linters own the checks they already do well — size, shape,
// complexity, duplication, unused code, import graph — and nothing here
// re-implements them. The type-aware rules carry most of the weight, since the
// project is type-checked anyway.
//
// Thresholds match gorefactor's structural sensors so the two languages are
// judged on the same scale: 75-line functions, cyclomatic complexity 15,
// nesting depth 5.

import js from "@eslint/js";
import importX from "eslint-plugin-import-x";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "test/fixtures/**", "coverage/**"] },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  // unopinionated drops unicorn's naming and style opinions (name-replacements,
  // catch-error-name, switch-case-braces) and keeps its correctness rules.
  unicorn.configs.unopinionated,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    settings: {
      "import-x/resolver-next": [importX.createNodeResolver({ extensions: [".ts", ".js"] })],
    },
    rules: {
      // Size and shape, gorefactor's thresholds.
      complexity: ["warn", 15],
      "max-lines-per-function": ["warn", { max: 75, skipBlankLines: true, skipComments: true }],
      "max-depth": ["warn", 5],
      "max-params": ["warn", 6],
      "sonarjs/cognitive-complexity": ["warn", 20],

      // The import graph: cycles and fan-out, which no per-file rule sees.
      "import-x/no-cycle": ["error", { maxDepth: Infinity }],
      "import-x/max-dependencies": ["warn", { max: 12, ignoreTypeImports: true }],
      "import-x/no-useless-path-segments": "error",

      // This is a CLI that writes to stdout and sets process.exitCode.
      "unicorn/no-process-exit": "error",
      "no-console": "error",
      "unicorn/prefer-top-level-await": "off",
      "unicorn/no-null": "off",
      // Sorting a copy is the idiom here ([...xs].sort(cmp)); toSorted and the
      // immutability rules buy nothing once the array is already local.
      "unicorn/no-array-sort": "off",
      "sonarjs/no-misleading-array-reverse": "off",
      // Named imports from node: builtins are this codebase's style.
      "unicorn/import-style": "off",
      // Running git (and sh, in tests) from PATH is what this tool does; the
      // environment is scrubbed of the GIT_* variables that would redirect it.
      "sonarjs/no-os-command-from-path": "off",

      // ts-morph's API is a fluent chain of possibly-undefined nodes; the
      // strict-boolean and non-null rules fight it more than they help.
      "@typescript-eslint/no-non-null-assertion": "off",
      // Index signatures are read with brackets on purpose: details["line"],
      // process.env["PATH"]. The dot form would bypass noUncheckedIndexedAccess.
      "@typescript-eslint/dot-notation": ["error", { allowIndexSignaturePropertyAccess: true }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true, allowArray: true }],
    },
  },

  {
    // Tests: fixtures are long by nature, and duplicated literals are the point.
    files: ["test/**/*.ts"],
    rules: {
      // node:test's test() returns a promise nobody is meant to await.
      "@typescript-eslint/no-floating-promises": "off",
      "max-lines-per-function": "off",
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/no-identical-functions": "off",
      // Assertion messages interpolate whatever the envelope holds.
      "unicorn/no-useless-template-literals": "off",
      "unicorn/no-null": "off",
    },
  },

  {
    // This config file is not in tsconfig.json's project.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      // Plugins export their configs as members of a default export.
      "import-x/no-named-as-default": "off",
      "import-x/no-named-as-default-member": "off",
    },
  },
);
