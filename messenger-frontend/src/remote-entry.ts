import { NgModule } from "@angular/core";
import { RouterModule, Routes } from "@angular/router";
import { TranslateService, TranslateStore } from "@ngx-translate/core";
import { AuthenticatedLayoutComponent } from "./modules/shared/authenticated-layout/authenticated-layout.component";
import { registerRemoteTranslations } from "@datha/platform-ui";
import { REMOTE_TRANSLATION_BUNDLES } from "src/i18n/remote-translation-bundles";

/**
 * Lazy routes for the messenger remote, mounted at /messenger by the shell.
 *
 * Uses RouterModule.forChild so that @ngtools/webpack (the Angular compiler
 * plugin) sees an Angular decorator and properly compiles + emits this file.
 *
 * Translations: when hosted by the shell, AppModule is never bootstrapped so
 * the remote's i18n keys are never registered. registerRemoteTranslations
 * merges top-level keys (replacing whole subtrees) so remotes do not clobber
 * each other when switching between them.
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
        path: "chats",
        loadChildren: () =>
          import("./modules/chats/chats.routes").then((m) => m.CHATS_ROUTES),
      },
    ],
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
})
export class MessengerRemoteEntryModule {
  constructor(translate: TranslateService, store: TranslateStore) {
    registerRemoteTranslations(translate, store, REMOTE_TRANSLATION_BUNDLES);
  }
}
