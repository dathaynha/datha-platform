import { HTTP_INTERCEPTORS } from "@angular/common/http";
import { NgModule } from "@angular/core";
import { AuthInterceptor, DEFAULT_TIMEOUT } from "./auth.interceptor";
import { TranslateInterceptor } from "./translate.interceptor";

@NgModule({
  providers: [
    {
      provide: DEFAULT_TIMEOUT,
      useValue: 180000,
    },
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthInterceptor,
      multi: true,
    },
    {
      provide: HTTP_INTERCEPTORS,
      useClass: TranslateInterceptor,
      multi: true,
    },
  ],
})
export class InterceptorsModule {}
