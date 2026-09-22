import { TestBed } from "@angular/core/testing";
import { TranslateModule } from "@ngx-translate/core";
import { ProfilePopoverComponent } from "./profile-popover.component";

describe("ProfilePopoverComponent", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ProfilePopoverComponent, TranslateModule.forRoot()],
    });
  });

  function createOpenPopover(inputs: Record<string, string>) {
    const fixture = TestBed.createComponent(ProfilePopoverComponent);
    for (const [key, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(key, value);
    }
    fixture.detectChanges();
    fixture.componentInstance
      .popover()
      .show(new MouseEvent("click"), fixture.nativeElement);
    fixture.detectChanges();
    return fixture;
  }

  it("renders only rows with values", () => {
    const fixture = createOpenPopover({
      name: "Dat Ha",
      email: "dat@example.com",
    });

    const text = document.body.textContent ?? "";
    expect(text).toContain("Dat Ha");
    expect(text).toContain("dat@example.com");
    expect(fixture.nativeElement).toBeTruthy();
    expect(document.body.querySelectorAll("dt").length).toBe(2);
  });

  it("emits logout and hides the popover", () => {
    const fixture = createOpenPopover({ name: "Dat Ha" });
    const emitted = jasmine.createSpy("logout");
    fixture.componentInstance.logout.subscribe(emitted);

    fixture.componentInstance.onLogout();
    expect(emitted).toHaveBeenCalled();
  });

  it("renders no menu section by default", () => {
    createOpenPopover({ name: "Dat Ha" });
    expect(document.body.textContent).not.toContain("SETTINGS.NAV");
  });

  it("renders menu items and emits the selected item", () => {
    const fixture = TestBed.createComponent(ProfilePopoverComponent);
    const item = { id: "settings", labelKey: "SETTINGS.NAV", icon: "pi-cog" };
    fixture.componentRef.setInput("menuItems", [item]);
    fixture.detectChanges();
    fixture.componentInstance
      .popover()
      .show(new MouseEvent("click"), fixture.nativeElement);
    fixture.detectChanges();

    // labelKey passes through translate (no catalog in test → key itself)
    expect(document.body.textContent).toContain("SETTINGS.NAV");

    const emitted = jasmine.createSpy("menuItemSelect");
    fixture.componentInstance.menuItemSelect.subscribe(emitted);
    fixture.componentInstance.onMenuItem(item);
    expect(emitted).toHaveBeenCalledWith(item);
  });

  afterEach(() => {
    document.body
      .querySelectorAll("[data-pc-name], .p-popover")
      .forEach((el) => el.remove());
  });
});
