import { HttpClientTestingModule } from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { OAuthModule, OAuthService } from "angular-oauth2-oidc";

import { AuthenticationService } from "./authentication.service";

describe("AuthenticationService", () => {
  let service: AuthenticationService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [OAuthModule.forRoot(), HttpClientTestingModule],
    });
    service = TestBed.inject(AuthenticationService);
  });

  it("should be created", () => {
    expect(service).toBeTruthy();
  });
});

/**
 * The reason this assertion exists: logOut() without the flag redirects to the
 * IdP's end_session_endpoint, ending the provider's own session and signing the
 * user out of every other site using it. Entra publishes that endpoint, Google
 * does not — so dropping the flag silently makes logout behave differently per
 * provider. This remote runs standalone in dev, so it owns its own logout.
 */
describe("AuthenticationService (logout)", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [OAuthModule.forRoot(), HttpClientTestingModule],
    });
  });

  it("logs out locally without redirecting to the identity provider", () => {
    const service = TestBed.inject(AuthenticationService);
    const logOutSpy = spyOn(TestBed.inject(OAuthService), "logOut");
    spyOn(TestBed.inject(Router), "navigate").and.returnValue(
      Promise.resolve(true),
    );

    service.logout();

    expect(logOutSpy).toHaveBeenCalled();
    expect(logOutSpy.calls.mostRecent().args[0])
      .withContext(
        "logOut must be called with true (no redirect to the IdP end_session_endpoint)",
      )
      .toBeTrue();
  });
});
