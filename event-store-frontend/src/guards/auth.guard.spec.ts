import { HttpClientTestingModule } from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { OAuthModule } from "angular-oauth2-oidc";

import { AuthGuard } from "./auth.guard";

describe("AuthGuard", () => {
  let guard: AuthGuard;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [OAuthModule.forRoot(), HttpClientTestingModule],
    });
    guard = TestBed.inject(AuthGuard);
  });

  it("should be created", () => {
    expect(guard).toBeTruthy();
  });
});
