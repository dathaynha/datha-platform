import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { OAuthService } from "angular-oauth2-oidc";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { AuthenticationService, AuthProvider } from "./authentication.service";
import { EnvService } from "./config.service";

describe("AuthenticationService (logout)", () => {
  let logOutCalls: unknown[][];
  let navigated: unknown[][];

  function setup(): AuthenticationService {
    logOutCalls = [];
    navigated = [];
    TestBed.configureTestingModule({
      providers: [
        AuthenticationService,
        {
          provide: OAuthService,
          useValue: {
            logOut: (...args: unknown[]) => {
              logOutCalls.push(args);
            },
          },
        },
        {
          provide: Router,
          useValue: {
            navigate: (...args: unknown[]) => {
              navigated.push(args);
              return Promise.resolve(true);
            },
          },
        },
        { provide: EnvService, useValue: { loadEnvs: () => undefined } },
      ],
    });
    return TestBed.inject(AuthenticationService);
  }

  afterEach(() => {
    localStorage.removeItem(LOCAL_STORAGE_KEY.LOGIN_TIME);
    localStorage.removeItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER);
  });

  /**
   * The reason this assertion exists: logOut() without the flag redirects to
   * the IdP's end_session_endpoint, ending the provider's own session and
   * signing the user out of every other site using it. Entra publishes that
   * endpoint, Google does not — so dropping the flag silently makes logout
   * behave differently per provider.
   */
  it("logs out locally without redirecting to the identity provider", () => {
    const service = setup();

    service.logout();

    expect(logOutCalls.length).toBe(1);
    expect(logOutCalls[0][0])
      .withContext(
        "logOut must be called with true (no redirect to the IdP end_session_endpoint)",
      )
      .toBeTrue();
  });

  it("clears the stored session and returns to /login", () => {
    const service = setup();
    localStorage.setItem(LOCAL_STORAGE_KEY.LOGIN_TIME, "123");
    localStorage.setItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER, AuthProvider.GOOGLE);

    service.logout();

    expect(localStorage.getItem(LOCAL_STORAGE_KEY.LOGIN_TIME)).toBeNull();
    expect(localStorage.getItem(LOCAL_STORAGE_KEY.AUTH_PROVIDER)).toBeNull();
    expect(navigated).toEqual([[["/login"]]]);
  });
});
