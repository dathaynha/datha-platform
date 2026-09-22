import { importProvidersFrom } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";

import { AppComponent } from "./modules/app.component";
import { AppModule } from "./modules/app.module";

bootstrapApplication(AppComponent, {
  providers: [importProvidersFrom(AppModule)],
}).catch((err) => console.error(err));

// Web Push service worker (src/sw.js served at /sw.js) — registration is
// idempotent; permission is only ever requested from the settings toggle.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");
}
