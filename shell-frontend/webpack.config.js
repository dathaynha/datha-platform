const {
  shareAll,
  withModuleFederationPlugin,
} = require("@angular-architects/module-federation/webpack");
const { readFileSync } = require("fs");
const { join } = require("path");

// Same guard as chatbot's webpack.config.js: filter out TypeScript path aliases
// (e.g. @pipes, @services) that shareAll incorrectly treats as npm packages.
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
const realPackages = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
]);

const allShared = shareAll({
  singleton: true,
  strictVersion: false,
  requiredVersion: "auto",
});

function rootPackage(name) {
  if (name.startsWith("@")) {
    const parts = name.split("/");
    return parts[0] + "/" + parts[1];
  }
  return name.split("/")[0];
}

const shared = Object.fromEntries(
  Object.entries(allShared).filter(([key]) => realPackages.has(rootPackage(key)))
);

const mfConfig = withModuleFederationPlugin({
  // Remotes are loaded dynamically at runtime via federation.manifest.json.
  // Add static remotes here only if needed for SSR or build-time type safety.
  remotes: {},
  // Prevent auto-sharing of non-wildcard tsconfig path aliases (same reason as chatbot).
  sharedMappings: [],
  shared,
});

// Override publicPath to avoid webpack 5 using import.meta.url for asset
// resolution. "auto" causes a SyntaxError in non-module scripts at runtime.
module.exports = {
  ...mfConfig,
  output: {
    ...mfConfig.output,
    publicPath: "/",
  },
};
