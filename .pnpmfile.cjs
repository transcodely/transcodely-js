/**
 * The React 18 test project (vitest.config.ts) loads `react-dom-18`, an npm
 * alias of react-dom@18. Left alone, pnpm satisfies its `react` peer with the
 * workspace's React 19, so "React 18" tests would render with React 19's
 * core. Turning that peer into a pinned dependency gives react-dom@18 its own
 * React 18 — the same store copy the `react-18` alias points at. Dev install
 * only: the published package's manifest is untouched.
 */
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "react-dom" && pkg.version.startsWith("18.")) {
        if (pkg.peerDependencies) delete pkg.peerDependencies.react;
        pkg.dependencies = { ...pkg.dependencies, react: pkg.version };
      }
      return pkg;
    },
  },
};
