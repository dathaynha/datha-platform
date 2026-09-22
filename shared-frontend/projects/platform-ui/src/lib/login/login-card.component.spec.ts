import { TestBed } from "@angular/core/testing";
import { TranslateModule } from "@ngx-translate/core";
import type { DathaEntraPool } from "./login-card.component";
import { LoginCardComponent } from "./login-card.component";

describe("LoginCardComponent", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoginCardComponent, TranslateModule.forRoot()],
    }).compileComponents();
  });

  function buttons(el: HTMLElement): HTMLButtonElement[] {
    return Array.from(el.querySelectorAll("button.login-btn"));
  }

  // Karma hosts specs inside an iframe, which would trip the embedded guard.
  function createFixture() {
    const fixture = TestBed.createComponent(LoginCardComponent);
    fixture.componentRef.setInput("embeddedGuard", false);
    return fixture;
  }

  it("renders three provider buttons and emits per provider", () => {
    const fixture = createFixture();
    const google = jasmine.createSpy("google");
    const entra = jasmine.createSpy("entra");
    fixture.componentInstance.googleLogin.subscribe(google);
    fixture.componentInstance.entraLogin.subscribe(entra);
    fixture.detectChanges();

    const [g, work, personal] = buttons(fixture.nativeElement);
    g.click();
    work.click();
    personal.click();

    expect(google).toHaveBeenCalled();
    expect(entra.calls.allArgs()).toEqual([["organizations"], ["consumers"]]);
  });

  it("disables all buttons and shows a spinner while busy", () => {
    const fixture = createFixture();
    fixture.componentRef.setInput(
      "busyEntraPool",
      "organizations" satisfies DathaEntraPool,
    );
    fixture.detectChanges();

    expect(buttons(fixture.nativeElement).every((b) => b.disabled)).toBeTrue();
    expect(
      fixture.nativeElement.querySelectorAll(".login-btn__spinner").length,
    ).toBe(1);
  });

  it("shows the error row only when errorKey is set", () => {
    const fixture = createFixture();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(".login-error")).toBeNull();

    fixture.componentRef.setInput("errorKey", "LOGIN.ERROR_GENERIC");
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector(".login-error")).not.toBeNull();
  });
});
