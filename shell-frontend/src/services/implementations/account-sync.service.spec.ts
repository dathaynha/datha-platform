import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { environment } from "src/environments/environment";
import { SKIP_GLOBAL_ERROR_DIALOG } from "src/interceptors/http-context.tokens";
import { AccountSyncService } from "./account-sync.service";

const SYNC_URL = `${environment.gateway.baseUrl}/api/accounts/users/me/sync`;

describe("AccountSyncService", () => {
  let service: AccountSyncService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AccountSyncService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  it("posts to the sync endpoint with no identity in the body", async () => {
    const pending = service.sync();
    const request = http.expectOne(SYNC_URL);

    expect(request.request.method).toBe("POST");
    // accounts-service takes the owner from gateway-injected headers. Sending
    // an identity here would be a client claiming who it is.
    expect(request.request.body).toEqual({});

    request.flush({ data: { profile: {}, workspaces: [], created: true } });
    await pending;
  });

  it("suppresses the global error dialog", async () => {
    const pending = service.sync();
    const request = http.expectOne(SYNC_URL);

    // accounts-service being down must not stack a modal over the app on every
    // single load — the row simply appears on the next start.
    expect(request.request.context.get(SKIP_GLOBAL_ERROR_DIALOG)).toBeTrue();

    request.flush({}, { status: 503, statusText: "Service Unavailable" });
    await pending;
  });

  it("resolves rather than throwing when the sync fails", async () => {
    const warn = spyOn(console, "warn");
    const pending = service.sync();

    http
      .expectOne(SYNC_URL)
      .flush({}, { status: 500, statusText: "Internal Server Error" });

    // App start must not depend on this: it is provisioning, not auth.
    await expectAsync(pending).toBeResolved();
    expect(warn).toHaveBeenCalled();
  });
});
