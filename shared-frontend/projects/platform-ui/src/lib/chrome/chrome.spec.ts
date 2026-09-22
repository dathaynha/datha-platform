import { Component } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { RouterTestingHarness } from "@angular/router/testing";
import { TranslateModule } from "@ngx-translate/core";
import {
  SubHeaderComponent,
  type DathaSubHeaderTab,
} from "./sub-header.component";

const TABS: DathaSubHeaderTab[] = [
  { id: "overview", labelKey: "NAV.OVERVIEW", route: "/", exact: true },
  { id: "chat", labelKey: "NAV.CHAT", route: "/chat" },
];

@Component({
  selector: "datha-chrome-spec-host",
  imports: [SubHeaderComponent],
  template: `
    <datha-sub-header [tabs]="tabs" navAriaLabelKey="NAV.ARIA">
      <button type="button" class="host-action">action</button>
    </datha-sub-header>
  `,
})
class HostComponent {
  tabs = TABS;
}

@Component({ selector: "datha-blank", template: "" })
class BlankComponent {}

describe("SubHeaderComponent", () => {
  async function renderAt(url: string): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      imports: [HostComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([
          { path: "", component: HostComponent },
          { path: "chat", component: HostComponent },
          { path: "other", component: BlankComponent },
        ]),
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, HostComponent);
    harness.detectChanges();
    return harness.routeNativeElement as HTMLElement;
  }

  it("renders one anchor per tab, not a button", async () => {
    const el = await renderAt("/");
    const tabs = el.querySelectorAll<HTMLAnchorElement>(
      ".datha-sub-header__tab",
    );

    expect(tabs.length).toBe(2);
    tabs.forEach((tab) => expect(tab.tagName).toBe("A"));
    // Real hrefs are the point: middle-click / open-in-new-tab must work.
    expect(tabs[1].getAttribute("href")).toBe("/chat");
  });

  it("marks only the active tab with aria-current and the active class", async () => {
    const el = await renderAt("/chat");
    const tabs = el.querySelectorAll<HTMLAnchorElement>(
      ".datha-sub-header__tab",
    );

    expect(tabs[0].getAttribute("aria-current")).toBeNull();
    expect(tabs[1].getAttribute("aria-current")).toBe("page");
    expect(
      tabs[1].classList.contains("datha-sub-header__tab--active"),
    ).toBeTrue();
    expect(
      tabs[0].classList.contains("datha-sub-header__tab--active"),
    ).toBeFalse();
  });

  it("honours exact matching so the overview tab does not stay active", async () => {
    const el = await renderAt("/chat");
    const overview = el.querySelector<HTMLAnchorElement>(
      ".datha-sub-header__tab",
    )!;

    expect(overview.getAttribute("aria-current")).toBeNull();
  });

  it("names the nav from navAriaLabelKey", async () => {
    const el = await renderAt("/");
    const nav = el.querySelector<HTMLElement>(".datha-sub-header__tabs")!;

    expect(nav.tagName).toBe("NAV");
    expect(nav.getAttribute("aria-label")).toBe("NAV.ARIA");
  });

  it("projects action content into the trailing slot", async () => {
    const el = await renderAt("/");
    const actions = el.querySelector<HTMLElement>(
      ".datha-sub-header__actions",
    )!;

    expect(actions.querySelector(".host-action")).toBeTruthy();
  });

  it("omits the nav entirely when no tabs are passed", async () => {
    TestBed.configureTestingModule({
      imports: [SubHeaderComponent, TranslateModule.forRoot()],
      providers: [provideRouter([])],
    });
    const fixture = TestBed.createComponent(SubHeaderComponent);
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector(".datha-sub-header__tabs"),
    ).toBeNull();
    expect(
      fixture.nativeElement.querySelector(".datha-sub-header__actions"),
    ).toBeTruthy();
  });
});
