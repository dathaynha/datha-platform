import { Injectable } from "@angular/core";
import {
  ActivatedRouteSnapshot,
  CanActivate,
  CanLoad,
  Router,
  RouterStateSnapshot,
} from "@angular/router";
import { OAuthService } from "angular-oauth2-oidc";

@Injectable({
  providedIn: "root",
})
export class AuthGuard implements CanLoad, CanActivate {
  constructor(
    private oAuthService: OAuthService,
    private router: Router,
  ) {}

  canLoad() {
    return this.oAuthService.hasValidAccessToken();
  }

  canActivate(_route: ActivatedRouteSnapshot, _state: RouterStateSnapshot) {
    if (this.oAuthService.hasValidAccessToken()) {
      return true;
    }
    void this.router.navigate(["/login"]);
    return false;
  }
}
