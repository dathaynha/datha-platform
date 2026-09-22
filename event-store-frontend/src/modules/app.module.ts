import { registerLocaleData } from "@angular/common";
import {
  provideHttpClient,
  withInterceptorsFromDi,
} from "@angular/common/http";
import localeDe from "@angular/common/locales/de";
import localeEn from "@angular/common/locales/en";
import { APP_INITIALIZER, NgModule } from "@angular/core";
import { TranslateService } from "@ngx-translate/core";
import defaultLanguage from "src/assets/i18n/en.json";
import { BrowserModule } from "@angular/platform-browser";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { storageFactory } from "@factories/index";
import { provideTranslateHttpLoader } from "@ngx-translate/http-loader";
import { OAuthStorage } from "angular-oauth2-oidc";
import { providePrimeNG } from "primeng/config";
import { platformAuraPreset } from "@datha/platform-ui";
import { DialogService, DynamicDialogModule } from "primeng/dynamicdialog";
import { AuthenticationService } from "@services/implementations/authentication.service";
import { InterceptorsModule } from "src/interceptors/interceptors.module";
import { AuthenticatedLayoutComponent } from "./shared/authenticated-layout/authenticated-layout.component";
import { UnauthenticatedLayoutComponent } from "./shared/unauthenticated-layout/unauthenticated-layout.component";

function authBootstrapFactory(auth: AuthenticationService) {
  return () => auth.bootstrapAuth();
}

function i18nInitFactory(translate: TranslateService) {
  return () => {
    translate.setTranslation("en", defaultLanguage, true);
    translate.setDefaultLang("en");
  };
}

import { AppRoutingModule } from "./app-routing.module";
import { I18nRootModule } from "./i18n-root.module";
import { OAuthRootModule } from "./oauth-root.module";

registerLocaleData(localeDe);
registerLocaleData(localeEn);

@NgModule({
  imports: [
    OAuthRootModule,
    BrowserModule,
    AppRoutingModule,
    DynamicDialogModule,
    AuthenticatedLayoutComponent,
    UnauthenticatedLayoutComponent,
    InterceptorsModule,
    I18nRootModule,
  ],
  providers: [
    {
      provide: APP_INITIALIZER,
      useFactory: i18nInitFactory,
      deps: [TranslateService],
      multi: true,
    },
    {
      provide: APP_INITIALIZER,
      useFactory: authBootstrapFactory,
      deps: [AuthenticationService],
      multi: true,
    },
    DialogService,
    provideHttpClient(withInterceptorsFromDi()),
    provideAnimationsAsync(),
    provideTranslateHttpLoader({
      prefix: "assets/i18n/",
      suffix: ".json",
    }),
    providePrimeNG({
      theme: {
        preset: platformAuraPreset,
        options: {
          darkModeSelector: ".dark",
        },
      },
    }),
    {
      provide: OAuthStorage,
      useFactory: storageFactory,
    },
  ],
})
export class AppModule {}
