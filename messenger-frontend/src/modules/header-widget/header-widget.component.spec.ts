import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { Router } from "@angular/router";
import { OAuthService } from "angular-oauth2-oidc";
import { TranslateModule } from "@ngx-translate/core";
import { HeaderWidgetComponent } from "./header-widget.component";

describe("HeaderWidgetComponent", () => {
  let fixture: ComponentFixture<HeaderWidgetComponent>;
  let navigate: jasmine.Spy;

  beforeEach(async () => {
    navigate = jasmine.createSpy("navigate").and.resolveTo(true);
    await TestBed.configureTestingModule({
      imports: [HeaderWidgetComponent, TranslateModule.forRoot()],
      providers: [
        { provide: Router, useValue: { navigate } },
        // Reached through ChatStore, which resolves the owner id from the token.
        { provide: OAuthService, useValue: { getAccessToken: () => null } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(HeaderWidgetComponent);
    fixture.detectChanges();
  });

  it("renders the trigger with an accessible label", () => {
    const button: HTMLButtonElement =
      fixture.nativeElement.querySelector("button");
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-label")).toBe("MESSENGER.WIDGET.ARIA");
  });

  it("navigates to /messenger from the popover footer", async () => {
    await fixture.componentInstance.openMessenger();
    expect(navigate).toHaveBeenCalledWith(["/messenger"]);
  });

  it("navigates instead of opening the popover on a narrow viewport", () => {
    const original = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      value: 480,
      configurable: true,
    });

    fixture.componentInstance.onTriggerClick(new MouseEvent("click"));

    expect(navigate).toHaveBeenCalledWith(["/messenger"]);
    Object.defineProperty(window, "innerWidth", {
      value: original,
      configurable: true,
    });
  });
});
