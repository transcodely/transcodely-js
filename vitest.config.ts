import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * One vitest run covers both workspace packages and the React layer.
 *
 * The CLI imports the SDK by its published name, and the subpath entries
 * import the upload core by theirs; the aliases point those at TypeScript
 * source so the tests never depend on a prior `pnpm build`. They are exact
 * matches (regexes): a plain string alias is a prefix match, so
 * "@transcodely/sdk" would also swallow "@transcodely/sdk/upload".
 */
const sdkAliases = [
  { find: /^@transcodely\/sdk$/, replacement: at("./src/index.ts") },
  { find: /^@transcodely\/sdk\/upload$/, replacement: at("./src/browser-upload/index.ts") },
  { find: /^@transcodely\/sdk\/upload\/server$/, replacement: at("./src/browser-upload/server.ts") },
  { find: /^@transcodely\/sdk\/react$/, replacement: at("./src/react/index.ts") },
];

/**
 * The component tests run twice, against React 19 (the `react`/`react-dom`
 * dev dependencies) and React 18 (the `react-18`/`react-dom-18` npm aliases),
 * in a DOM implemented in Node by happy-dom — never a real browser. Each
 * project asserts the React major it loaded (tests/react/version.test.tsx),
 * so an alias that silently stopped applying fails loudly. react-dom@18 gets
 * its own React 18 through .pnpmfile.cjs, the same copy `react-18` names.
 */
function reactProject(major: 18 | 19) {
  const react = major === 18 ? "react-18" : "react";
  const reactDom = major === 18 ? "react-dom-18" : "react-dom";
  return {
    extends: true as const,
    resolve: {
      alias: [
        { find: /^react(\/.*)?$/, replacement: `${at(`./node_modules/${react}`)}$1` },
        { find: /^react-dom(\/.*)?$/, replacement: `${at(`./node_modules/${reactDom}`)}$1` },
      ],
    },
    test: {
      name: `react-${major}`,
      environment: "happy-dom",
      include: ["tests/react/**/*.test.tsx"],
      setupFiles: ["tests/react/setup.ts"],
      env: { EXPECTED_REACT_MAJOR: String(major) },
    },
  };
}

export default defineConfig({
  resolve: { alias: sdkAliases },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          // Builds dist/ once when it is missing or stale, before any file
          // runs; see the file.
          globalSetup: ["tests/package/build.ts"],
          include: ["tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
        },
      },
      reactProject(19),
      reactProject(18),
    ],
  },
});
