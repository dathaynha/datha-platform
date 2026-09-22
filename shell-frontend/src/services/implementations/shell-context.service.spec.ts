import { EventEmitter } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { TranslateService } from "@ngx-translate/core";
import { OAuthService } from "angular-oauth2-oidc";
import { Subject } from "rxjs";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { AuthenticationService } from "./authentication.service";
import { ShellContextService } from "./shell-context.service";

describe("ShellContextService (theme)", () => {
  let oauthEvents: Subject<unknown>;

  function setup(): ShellContextService {
    oauthEvents = new Subject();
    TestBed.configureTestingModule({
      providers: [
        ShellContextService,
        {
          provide: OAuthService,
          useValue: {
            getAccessToken: () => null,
            getIdentityClaims: () => null,
            events: oauthEvents.asObservable(),
          },
        },
        {
          provide: AuthenticationService,
          useValue: { logout: () => undefined },
        },
        {
          provide: TranslateService,
          useValue: { onLangChange: new EventEmitter(), use: () => undefined },
        },
      ],
    });
    return TestBed.inject(ShellContextService);
  }

  afterEach(() => localStorage.removeItem(LOCAL_STORAGE_KEY.THEME));

  it("setTheme persists to localStorage and emits on theme$", () => {
    const service = setup();
    const seen: string[] = [];
    service.theme$.subscribe((t) => seen.push(t));

    service.setTheme("midnight");

    expect(localStorage.getItem(LOCAL_STORAGE_KEY.THEME)).toBe("midnight");
    expect(service.currentThemeId).toBe("midnight");
    expect(seen).toEqual(["starlight", "midnight"]);
  });

  it("normalizes a legacy stored value on construction and rewrites it", () => {
    localStorage.setItem(LOCAL_STORAGE_KEY.THEME, "dark");

    const service = setup();

    expect(service.currentThemeId).toBe("midnight");
    expect(localStorage.getItem(LOCAL_STORAGE_KEY.THEME)).toBe("midnight");
  });

  it("defaults to starlight with no stored theme", () => {
    const service = setup();
    expect(service.currentThemeId).toBe("starlight");
  });
});
