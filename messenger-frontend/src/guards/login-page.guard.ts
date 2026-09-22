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
export class LoginPageGuard implements CanLoad, CanActivate {
  constructor(
    private oAuthService: OAuthService,
    private router: Router,
  ) {}

  canLoad() {
    return this.handleLoginPage();
  }

  canActivate(_route: ActivatedRouteSnapshot, _state: RouterStateSnapshot) {
    return this.handleLoginPage();
  }

  private handleLoginPage(): boolean {
    if (this.oAuthService.hasValidAccessToken()) {
      void this.router.navigate([""]);
      return false;
    }
    return true;
  }
}
