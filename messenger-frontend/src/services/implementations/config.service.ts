import { Injectable } from "@angular/core";
import { EMPTY, Observable, of } from "rxjs";
import { isEmpty, isObject, get, forEach } from "lodash";
import { tap, publishReplay, refCount } from "rxjs/operators";

@Injectable({
  providedIn: "root",
})
export class EnvService {
  envs: any;
  private envObservable: Observable<any>;

  loadEnvs = () => {
    this.envObservable = this.getProxyEnvs().pipe(
      tap((env: any) => {
        forEach(
          env,
          (value: string | { [key: string]: string }, key: string) => {
            (<any>window).ENV[key] = value;
          },
        );
      }),
      publishReplay(1),
      refCount(),
    );
    this.envObservable.subscribe(() => {});
  };

  getEnvs = () => {
    if (!isEmpty(this.envs) && isObject(this.envs)) {
      return of(this.envs);
    }

    let proxyEnvs;
    try {
      proxyEnvs = this.getProxyEnvs();
    } catch (e) {}

    if (!isEmpty(proxyEnvs) && isObject(proxyEnvs)) {
      this.envs = proxyEnvs;
      return of(proxyEnvs);
    }

    return this.envObservable;
  };

  getProxyEnvs = (): Observable<any> => {
    const proxyEnvs = get(window, "PROXY_ENV");
    if (!proxyEnvs) {
      return EMPTY;
    }
    return of(proxyEnvs);
  };
}
