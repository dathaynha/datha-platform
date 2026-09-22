import { Location } from "@angular/common";
import { HttpClientTestingModule } from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { RouterTestingModule } from "@angular/router/testing";
import { OAuthModule, OAuthService } from "angular-oauth2-oidc";
import { TranslateModule } from "@ngx-translate/core";
import { BehaviorSubject, of } from "rxjs";
import { AuthenticationService } from "@services/implementations/authentication.service";
import { CommonService } from "@services/implementations/common.service";
import { ThemeService } from "@services/implementations/theme.service";
import { AppComponent } from "./app.component";

describe("AppComponent", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [
        AppComponent,
        OAuthModule.forRoot(),
        HttpClientTestingModule,
        TranslateModule.forRoot(),
        RouterTestingModule,
      ],
      providers: [
        {
          provide: ThemeService,
          useValue: {
            theme$: new BehaviorSubject<string | null>(null),
            setTheme: () => {},
          },
        },
        {
          provide: CommonService,
          useValue: {
            loading$: of(false),
          },
        },
      ],
    }).compileComponents();
    TestBed.inject(OAuthService);
    TestBed.inject(AuthenticationService);
    TestBed.inject(Location);
  });

  it("should create the app", () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });
});
