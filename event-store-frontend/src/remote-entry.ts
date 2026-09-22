import { NgModule } from "@angular/core";
import { RouterModule, Routes } from "@angular/router";
import { TranslateService, TranslateStore } from "@ngx-translate/core";
import { AuthenticatedLayoutComponent } from "./modules/shared/authenticated-layout/authenticated-layout.component";
import { registerRemoteTranslations } from "@datha/platform-ui";
import { REMOTE_TRANSLATION_BUNDLES } from "src/i18n/remote-translation-bundles";

/**
 * Lazy routes for the event-store remote, mounted at /event-store by the shell.
 *
 * Uses RouterModule.forChild so that @ngtools/webpack (the Angular compiler
 * plugin) sees an Angular decorator and properly compiles + emits this file.
 *
 * Translations: when hosted by the shell, AppModule is never bootstrapped so
 * the remote's i18n keys are never registered. registerRemoteTranslations
 * merges top-level keys (replacing whole subtrees like LANDING) so chatbot and
 * event-store do not clobber each other when switching remotes.
 *
 * Layout: AuthenticatedLayoutComponent reads data.shelled to show a slim
 * header (no lang/profile/logout — the shell owns those).
 */
const routes: Routes = [
  {
    path: "",
    component: AuthenticatedLayoutComponent,
    data: { shelled: true },
    children: [
      {
        path: "",
        loadComponent: () =>
          import("./modules/home-page/home-page.component").then(
            (m) => m.HomePageComponent,
          ),
      },
      {
        path: "events",
        loadChildren: () =>
          import("./modules/events/events.routes").then((m) => m.EVENTS_ROUTES),
      },
      {
        path: "dlq",
        loadChildren: () =>
          import("./modules/dlq/dlq.routes").then((m) => m.DLQ_ROUTES),
      },
    ],
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
})
export class EventStoreRemoteEntryModule {
  constructor(translate: TranslateService, store: TranslateStore) {
    registerRemoteTranslations(translate, store, REMOTE_TRANSLATION_BUNDLES);
  }
}
