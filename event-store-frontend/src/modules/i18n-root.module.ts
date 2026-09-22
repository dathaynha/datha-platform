import { NgModule } from "@angular/core";
import { TranslateLoader, TranslateModule } from "@ngx-translate/core";
import { TranslateHttpLoader } from "@ngx-translate/http-loader";

/**
 * Wraps TranslateModule.forRoot so AppModule.imports stays a list of static NgModule classes.
 * (TranslateModule.forRoot({...}) in AppModule triggers NG1010 with partial compilation.)
 */
@NgModule({
  imports: [
    TranslateModule.forRoot({
      loader: {
        provide: TranslateLoader,
        useClass: TranslateHttpLoader,
      },
    }),
  ],
  exports: [TranslateModule],
})
export class I18nRootModule {}
