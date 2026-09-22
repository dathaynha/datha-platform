import { importProvidersFrom } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";

import { AppComponent } from "./modules/app.component";
import { AppModule } from "./modules/app.module";

bootstrapApplication(AppComponent, {
  providers: [importProvidersFrom(AppModule)],
}).catch((err) => console.error(err));
