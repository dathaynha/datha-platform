import { readFile } from "node:fs/promises";

const tag = process.env.BUILD_SOURCEBRANCH?.replace("refs/tags/v", "");

if (!tag) {
  throw new Error("BUILD_SOURCEBRANCH must be a v-prefixed release tag.");
}

const packageJson = JSON.parse(
  await readFile(new URL("../projects/platform-ui/package.json", import.meta.url), "utf8"),
);

if (packageJson.version !== tag) {
  throw new Error(`Release tag v${tag} does not match package version ${packageJson.version}.`);
}

console.log(`Release version verified: ${tag}`);
