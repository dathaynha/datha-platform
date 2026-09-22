import { NgModule } from "@angular/core";
import { OAuthModule } from "angular-oauth2-oidc";

/** Wraps OAuthModule.forRoot() so AppModule.imports uses plain NgModule classes (avoids NG1010). */
@NgModule({
  imports: [OAuthModule.forRoot()],
  exports: [OAuthModule],
})
export class OAuthRootModule {}
