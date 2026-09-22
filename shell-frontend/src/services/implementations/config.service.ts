import { Injectable } from "@angular/core";
import { EMPTY, Observable, of } from "rxjs";
import { tap, publishReplay, refCount } from "rxjs/operators";

@Injectable({
  providedIn: "root",
})
export class EnvService {
  envs: unknown;
  private envObservable!: Observable<unknown>;

  loadEnvs = (): void => {
    this.envObservable = this.getProxyEnvs().pipe(
      tap((env: unknown) => {
        if (env && typeof env === "object") {
          const windowEnv =
            ((window as unknown as Record<string, unknown>)["ENV"] as
              Record<string, unknown> | undefined) ?? {};
          Object.entries(env as Record<string, unknown>).forEach(
            ([key, value]) => {
              windowEnv[key] = value;
            },
          );
          (window as unknown as Record<string, unknown>)["ENV"] = windowEnv;
        }
      }),
      publishReplay(1),
      refCount(),
    );
    this.envObservable.subscribe(() => {});
  };

  getProxyEnvs = (): Observable<unknown> => {
    const proxyEnvs = (window as unknown as Record<string, unknown>)[
      "PROXY_ENV"
    ];
    if (!proxyEnvs) {
      return EMPTY;
    }
    return of(proxyEnvs);
  };
}
