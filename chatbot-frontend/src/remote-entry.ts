import { NgModule } from "@angular/core";
import { RouterModule, Routes } from "@angular/router";
import { TranslateService, TranslateStore } from "@ngx-translate/core";
import { AuthenticatedLayoutComponent } from "./modules/shared/authenticated-layout/authenticated-layout.component";
import { registerRemoteTranslations } from "@datha/platform-ui";
import { REMOTE_TRANSLATION_BUNDLES } from "src/i18n/remote-translation-bundles";

/**
 * Lazy routes for the chatbot remote, mounted at /chatbot by the shell.
 *
 * Uses RouterModule.forChild so that @ngtools/webpack (the Angular compiler
 * plugin) sees an Angular decorator and properly compiles + emits this file.
 * A plain `export const routes: Routes` has no decorator, so the Angular
 * compiler treats the file as unused and emits an empty module — making
 * m.routes undefined when the shell loads it via Module Federation.
 *
 * Translations: when hosted by the shell, AppModule is never bootstrapped so
 * the chatbot's i18n keys are never registered. registerRemoteTranslations
 * merges top-level keys (replacing whole subtrees like LANDING) so chatbot and
 * event-store do not clobber each other when switching remotes.
 *
 * Layout: AuthenticatedLayoutComponent reads data.shelled to show a slim
 * tab-only header (no lang/profile/logout — the shell owns those).
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
        path: "chat",
        loadComponent: () =>
          import("./modules/chat-page/chat-page.component").then(
            (m) => m.ChatPageComponent,
          ),
      },
    ],
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
})
export class ChatbotRemoteEntryModule {
  constructor(translate: TranslateService, store: TranslateStore) {
    registerRemoteTranslations(translate, store, REMOTE_TRANSLATION_BUNDLES);
  }
}
