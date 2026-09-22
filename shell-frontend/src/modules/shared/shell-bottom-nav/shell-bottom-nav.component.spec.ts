import { Component } from "@angular/core";
import { TestBed, type ComponentFixture } from "@angular/core/testing";
import { Router, provideRouter } from "@angular/router";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import type { AppDescriptor } from "@models/index";
import {
  BOTTOM_NAV_SLOTS,
  ShellBottomNavComponent,
} from "./shell-bottom-nav.component";

@Component({ selector: "blank-route", template: "" })
class BlankRouteComponent {}

/** Real strings, because whether a label clips depends on how long it is. */
const TRANSLATIONS = {
  NAV: { HOME: "Home", PRIMARY: "Primary navigation", MORE: "More" },
  SETTINGS: { NAV: "Settings" },
  APPS: {
    CHATBOT: { NAME: "Chatbot" },
    EVENT_STORE: { NAME: "Event Store" },
    MESSENGER: { NAME: "Messenger" },
    INTERVIEW_PREP: { NAME: "Interview Prep" },
    SYNCED_3D_VIEWER: { NAME: "3D Viewer" },
    ANALYTICS: { NAME: "Analytics" },
    SEARCH: { NAME: "Search" },
    TRANSLATION: { NAME: "Translation" },
  },
};

const CATALOG: AppDescriptor[] = [
  { remoteName: "chatbot", icon: "pi-microchip-ai", route: "/chatbot" },
  { remoteName: "event-store", icon: "pi-database", route: "/event-store" },
  { remoteName: "messenger", icon: "pi-comments", route: "/messenger" },
  {
    remoteName: "interview-prep",
    icon: "pi-id-card",
    route: "/interview-prep",
  },
  {
    remoteName: "synced-3d-viewer",
    icon: "pi-box",
    route: "/synced-3d-viewer",
  },
  { remoteName: "analytics", icon: "pi-chart-bar", route: "/analytics" },
  { remoteName: "search", icon: "pi-search", route: "/search" },
  { remoteName: "translation", icon: "pi-language", route: "/translation" },
];

/**
 * The guard is a **rect**, not a count.
 *
 * Registering another product makes the bar outgrow the screen in silence:
 * nothing errors, nothing logs, and the destinations that no longer fit are
 * simply off the right edge. A count assertion passes the whole time.
 *
 * It asserts the bar's own overflow rather than label truncation, which is what
 * this was planned against. Measuring it showed labels never truncate: the
 * label carries `overflow: hidden`, but the **link** is the flex item, and a
 * flex item will not shrink below its content — so the links keep their width
 * and the bar overflows instead. The first draft asserted
 * `label.scrollWidth <= label.clientWidth` and stayed green against an
 * uncapped bar at eight products, which is how the wrong property was found.
 */
const PHONE_WIDTH = 375;

describe("ShellBottomNavComponent", () => {
  let fixture: ComponentFixture<ShellBottomNavComponent>;
  let wrapper: HTMLElement | null = null;

  function render(appCount: number): void {
    fixture = TestBed.createComponent(ShellBottomNavComponent);
    fixture.componentRef.setInput("apps", CATALOG.slice(0, appCount));

    // Phone width from the code, never from the viewport: CI runs karma in an
    // 800x600 ChromeHeadless, so a spec that waits for a narrow window
    // measures a desktop instead and passes against anything.
    wrapper = document.createElement("div");
    wrapper.style.width = `${PHONE_WIDTH}px`;
    wrapper.appendChild(fixture.nativeElement as HTMLElement);
    document.body.appendChild(wrapper);

    fixture.detectChanges();

    // `sm:hidden` is a *viewport* query — correctly so, the shell owns the
    // viewport — and at 800px wide it resolves to `display: none`, where every
    // rect is 0 and the truncation check is vacuously true. Forcing the phone
    // value on the instrument is what keeps the measurement about the product.
    nav().style.display = "flex";
  }

  function nav(): HTMLElement {
    return wrapper!.querySelector<HTMLElement>(
      '[data-testid="shell-bottom-nav"]',
    )!;
  }

  function labels(): HTMLElement[] {
    return Array.from(nav().querySelectorAll<HTMLElement>("span"));
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ShellBottomNavComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([{ path: "**", component: BlankRouteComponent }]),
      ],
    });

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation("en", TRANSLATIONS);
    translate.use("en");
  });

  afterEach(() => {
    wrapper?.remove();
    wrapper = null;
    document.querySelectorAll(".p-drawer-mask").forEach((m) => m.remove());
  });

  it("keeps every destination on the screen however many are registered", () => {
    for (const count of [3, 4, 6, 8]) {
      render(count);

      const bar = nav();
      expect(bar.querySelectorAll("a,button").length)
        .withContext(`${count} apps: the bar rendered nothing`)
        .toBeGreaterThan(0);

      // Uncapped this reads 390px at 5 apps and 545px at 8, in a 375px bar.
      expect(bar.scrollWidth)
        .withContext(
          `${count} apps: the bar needs ${bar.scrollWidth}px of the ` +
            `${bar.clientWidth}px it has — ${bar.scrollWidth - bar.clientWidth}px ` +
            `of destinations are off the right edge`,
        )
        .toBeLessThanOrEqual(bar.clientWidth);

      wrapper?.remove();
      wrapper = null;
    }
  });

  it("stops growing at the cap and spills the rest into the sheet", () => {
    render(6);

    const inBar =
      nav().querySelectorAll('[data-testid="shell-bottom-link"]').length +
      nav().querySelectorAll('[data-testid="shell-bottom-more"]').length;
    expect(inBar).toBe(BOTTOM_NAV_SLOTS);

    // Nothing is dropped — the tail products are in the sheet, with Settings.
    expect(
      fixture.componentInstance.sheetApps().map((app) => app.remoteName),
    ).toEqual(["interview-prep", "synced-3d-viewer", "analytics"]);
  });

  it("leaves the bar flat while everything still fits", () => {
    render(3);

    expect(fixture.componentInstance.overflows()).toBe(false);
    expect(nav().querySelector('[data-testid="shell-bottom-more"]')).toBeNull();

    // Settings keeps its own slot rather than costing a tap for no reason.
    expect(labels().map((l) => l.textContent?.trim())).toContain("Settings");
  });

  it("marks More active when the route is inside the sheet", async () => {
    render(6);
    const component = fixture.componentInstance;

    expect(component.moreActive()).toBe(false);

    // Someone standing on an overflow product must see "you are here"
    // somewhere in the bar; `routerLinkActive` cannot reach a button.
    await TestBed.inject(Router).navigateByUrl("/interview-prep/session/1");
    fixture.detectChanges();

    expect(component.moreActive()).toBe(true);
    expect(component.isSheetItemActive("/interview-prep")).toBe(true);
    expect(
      nav().querySelector('[data-testid="shell-bottom-more"]')!.classList,
    ).toContain("shell-bottom-link--active");
  });
});
