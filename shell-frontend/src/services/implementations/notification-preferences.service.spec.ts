import { provideHttpClient } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { TestBed, fakeAsync, tick } from "@angular/core/testing";
import { TranslateModule } from "@ngx-translate/core";
import type { NotificationPreferences } from "@models/index";
import { environment } from "src/environments/environment";
import { NotificationPreferencesService } from "./notification-preferences.service";

const URL = `${environment.gateway.baseUrl}/api/notifications/preferences`;

const PREFS: NotificationPreferences = {
  locale: "en",
  pushEnabled: false,
  pushMinSeverity: "info",
  emailDigest: false,
};

describe("NotificationPreferencesService", () => {
  let service: NotificationPreferencesService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(NotificationPreferencesService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  function loadPrefs(): void {
    void service.load();
    httpMock.expectOne(URL).flush(PREFS);
    tick();
  }

  it("loads preferences", fakeAsync(() => {
    loadPrefs();
    expect(service.preferences()).toEqual(PREFS);
  }));

  it("saves optimistically and keeps the server response", fakeAsync(() => {
    loadPrefs();

    void service.save({ pushEnabled: true });
    expect(service.preferences()?.pushEnabled).toBeTrue();

    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe("PUT");
    expect(req.request.body.pushEnabled).toBeTrue();
    req.flush({ ...PREFS, pushEnabled: true });
    tick();

    expect(service.preferences()?.pushEnabled).toBeTrue();
    expect(service.saveError()).toBeFalse();
  }));

  it("rolls back the optimistic value when the save fails", fakeAsync(() => {
    loadPrefs();

    void service.save({ emailDigest: true });
    expect(service.preferences()?.emailDigest).toBeTrue();

    httpMock.expectOne(URL).flush(null, { status: 500, statusText: "boom" });
    tick();

    expect(service.preferences()?.emailDigest).toBeFalse();
    expect(service.saveError()).toBeTrue();
  }));

  it("save is a no-op before load", fakeAsync(() => {
    void service.save({ pushEnabled: true });
    tick();
    httpMock.expectNone(URL);
  }));
});
