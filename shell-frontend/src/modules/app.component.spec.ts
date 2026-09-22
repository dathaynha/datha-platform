import { EventEmitter } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { BehaviorSubject, Subject } from "rxjs";
import { AuthenticationService } from "@services/implementations/authentication.service";
import { CommonService } from "@services/implementations/common.service";
import { ShellContextService } from "@services/implementations/shell-context.service";
import type { DathaThemeId } from "@datha/platform-ui";
import { DialogService } from "primeng/dynamicdialog";
import { AppComponent } from "./app.component";

describe("AppComponent (dark class sync)", () => {
  let theme$: BehaviorSubject<DathaThemeId>;

  beforeEach(async () => {
    theme$ = new BehaviorSubject<DathaThemeId>("starlight");
    await TestBed.configureTestingModule({
      imports: [AppComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([]),
        {
          provide: ShellContextService,
          useValue: {
            theme$: theme$.asObservable(),
            currentThemeId: "starlight",
          },
        },
        {
          provide: AuthenticationService,
          useValue: { isAuthenticated: () => false },
        },
        { provide: CommonService, useValue: { loading$: new Subject() } },
        {
          provide: TranslateService,
          useValue: { use: () => undefined, onLangChange: new EventEmitter() },
        },
        { provide: DialogService, useValue: { open: () => undefined } },
      ],
    }).compileComponents();
  });

  afterEach(() => document.documentElement.classList.remove("dark"));

  it("toggles .dark on documentElement when the theme changes", () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    expect(document.documentElement.classList.contains("dark")).toBeFalse();

    theme$.next("midnight");
    expect(document.documentElement.classList.contains("dark")).toBeTrue();

    theme$.next("starlight");
    expect(document.documentElement.classList.contains("dark")).toBeFalse();
  });

  it("removes .dark on destroy", () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    theme$.next("midnight");
    expect(document.documentElement.classList.contains("dark")).toBeTrue();

    fixture.destroy();
    expect(document.documentElement.classList.contains("dark")).toBeFalse();
  });
});
