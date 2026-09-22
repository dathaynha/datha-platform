const {
  shareAll,
  withModuleFederationPlugin,
} = require("@angular-architects/module-federation/webpack");
const { readFileSync } = require("fs");
const { join } = require("path");

// Build the set of real npm package names from package.json.
// shareAll also picks up TypeScript path aliases (e.g. @pipes, @services) as if they were
// npm packages, which pollutes the MF shared scope and causes module-ID collisions with the
// exposed remote-entry module.  Filter those out: only share packages that actually live in
// node_modules (i.e. are listed in package.json dependencies/devDependencies).
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

// Keep only modules whose root package is a real npm dependency.
// e.g. "@angular/core" → root = "@angular/core" (scoped)
//      "rxjs/operators" → root = "rxjs"          (unscoped sub-path)
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
  // This app is a REMOTE (loaded by shell-frontend).
  name: "chatbot",
  // Prevent withModuleFederationPlugin from auto-sharing non-wildcard tsconfig path aliases
  // (e.g. @pipes → src/pipes, @directives → src/directives) as MF shared modules.
  // Those aliases are local source folders, not npm packages; sharing them pollutes the MF
  // shared scope and causes module-ID collisions with the exposed remote-entry module.
  sharedMappings: [],
  exposes: {
    // Shell loads this as: loadRemoteModule({ type: "manifest", remoteName: "chatbot", exposedModule: "./Module" })
    "./Module": "./src/remote-entry.ts",
  },
  shared,
});

// publicPath must be set explicitly so webpack doesn't fall back to import.meta.url
// (which breaks non-module IIFE scripts).
// Override with MF_CHATBOT_PUBLIC_PATH in CI before building for non-dev environments,
// e.g.:  MF_CHATBOT_PUBLIC_PATH=https://chatbot.example.com/ pnpm build
const publicPath = process.env["MF_CHATBOT_PUBLIC_PATH"] ?? "http://localhost:4001/";

module.exports = {
  ...mfConfig,
  output: {
    ...mfConfig.output,
    publicPath,
  },
};
