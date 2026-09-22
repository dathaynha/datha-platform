import { Component, type Type } from "@angular/core";
import {
  TestBed,
  fakeAsync,
  tick,
  type ComponentFixture,
} from "@angular/core/testing";
import type { HeaderWidgetDescriptor } from "@models/index";
import { environment } from "src/environments/environment";
import {
  HEADER_WIDGET_MODULE_LOADER,
  HeaderWidgetHostComponent,
  type HeaderWidgetModuleLoader,
} from "./header-widget-host.component";

@Component({ selector: "stub-widget", template: `<span>widget</span>` })
class StubWidgetComponent {}

@Component({ selector: "stub-second-widget", template: `<span>second</span>` })
class StubSecondWidgetComponent {}

describe("HeaderWidgetHostComponent", () => {
  const env = environment as { headerWidgets?: HeaderWidgetDescriptor[] };
  let originalWidgets: HeaderWidgetDescriptor[] | undefined;

  function descriptor(
    remoteName: string,
    order: number,
  ): HeaderWidgetDescriptor {
    return { remoteName, exposedModule: "./HeaderWidget", order };
  }

  /** Called inside fakeAsync: tick() flushes the loader promises deterministically. */
  function setup(
    loader: HeaderWidgetModuleLoader,
  ): ComponentFixture<HeaderWidgetHostComponent> {
    TestBed.configureTestingModule({
      imports: [HeaderWidgetHostComponent],
      providers: [{ provide: HEADER_WIDGET_MODULE_LOADER, useValue: loader }],
    });
    const fixture = TestBed.createComponent(HeaderWidgetHostComponent);
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    originalWidgets = env.headerWidgets;
  });

  afterEach(() => {
    env.headerWidgets = originalWidgets;
    TestBed.resetTestingModule();
  });

  it("renders a widget exposed as a default export", fakeAsync(() => {
    env.headerWidgets = [descriptor("messenger", 20)];

    const fixture = setup(async () => ({
      default: StubWidgetComponent as Type<unknown>,
    }));

    expect(fixture.nativeElement.textContent).toContain("widget");
  }));

  it("renders nothing and does not throw when a remote fails to load", fakeAsync(() => {
    env.headerWidgets = [descriptor("messenger", 20)];

    const fixture = setup(() =>
      Promise.reject(new Error("remoteEntry.js 404")),
    );

    expect(fixture.componentInstance.widgets().length).toBe(0);
    expect(fixture.nativeElement.textContent.trim()).toBe("");
  }));

  it("skips a module with no default export", fakeAsync(() => {
    env.headerWidgets = [descriptor("messenger", 20)];

    const fixture = setup(async () => ({ NotDefault: StubWidgetComponent }));

    expect(fixture.componentInstance.widgets().length).toBe(0);
  }));

  it("keeps healthy widgets when a sibling remote is down", fakeAsync(() => {
    env.headerWidgets = [descriptor("broken", 10), descriptor("messenger", 20)];

    const fixture = setup(async (d) => {
      if (d.remoteName === "broken") throw new Error("remote down");
      return { default: StubWidgetComponent as Type<unknown> };
    });

    expect(
      fixture.componentInstance.widgets().map((w) => w.remoteName),
    ).toEqual(["messenger"]);
  }));

  it("orders widgets ascending by order", fakeAsync(() => {
    env.headerWidgets = [descriptor("second", 30), descriptor("first", 10)];

    const fixture = setup(async (d) => ({
      default: (d.remoteName === "first"
        ? StubWidgetComponent
        : StubSecondWidgetComponent) as Type<unknown>,
    }));

    expect(
      fixture.componentInstance.widgets().map((w) => w.remoteName),
    ).toEqual(["first", "second"]);
  }));

  it("renders nothing when no widgets are configured", fakeAsync(() => {
    env.headerWidgets = [];

    const fixture = setup(async () => ({
      default: StubWidgetComponent as Type<unknown>,
    }));

    expect(fixture.componentInstance.widgets().length).toBe(0);
  }));
});
