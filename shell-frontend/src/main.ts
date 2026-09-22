import { setManifest } from "@angular-architects/module-federation";
import { environment } from "./environments/environment";

// Build the MF manifest from the environment config so remote URLs are
// environment-specific (dev → localhost:4001/4002, int/prod → real CDN hosts).
// No static federation.manifest.json file is needed.
setManifest(environment.remotes, true)
  .then(() => import("./bootstrap"))
  .catch((err) => console.error("Failed to bootstrap application", err));
