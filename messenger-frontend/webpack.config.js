const {
  shareAll,
  withModuleFederationPlugin,
} = require("@angular-architects/module-federation/webpack");
const { readFileSync } = require("fs");
const { join } = require("path");

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
  name: "messenger",
  sharedMappings: [],
  exposes: {
    "./Module": "./src/remote-entry.ts",
    // Header slot content, loaded by the shell independently of the routes.
    "./HeaderWidget": "./src/header-widget-entry.ts",
  },
  shared,
});

const publicPath =
  process.env["MF_MESSENGER_PUBLIC_PATH"] ?? "http://localhost:4003/";

module.exports = {
  ...mfConfig,
  output: {
    ...mfConfig.output,
    publicPath,
  },
};
