import { TestBed } from "@angular/core/testing";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { LangSelectComponent } from "./lang-select.component";
import { ThemeSelectComponent } from "./theme-select.component";

describe("ThemeSelectComponent", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ThemeSelectComponent, TranslateModule.forRoot()],
    });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation("en", {
      THEME: {
        STARLIGHT: "Starlight",
        MIDNIGHT: "Midnight",
        LABEL: "Theme",
      },
    });
    translate.use("en");
  });

  it("builds one option per platform theme with i18n labels and icons", () => {
    const fixture = TestBed.createComponent(ThemeSelectComponent);
    fixture.detectChanges();

    const options = fixture.componentInstance.options();
    expect(options.map((o) => o.value)).toEqual(["starlight", "midnight"]);
    expect(options.map((o) => o.label)).toEqual(["Starlight", "Midnight"]);
    expect(options.every((o) => o.icon.startsWith("pi "))).toBeTrue();
  });

  it("re-resolves labels on language change", () => {
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation("de", {
      THEME: {
        STARLIGHT: "Sternenlicht",
        MIDNIGHT: "Mitternacht",
        LABEL: "Design",
      },
    });
    const fixture = TestBed.createComponent(ThemeSelectComponent);
    fixture.detectChanges();

    translate.use("de");
    expect(fixture.componentInstance.options().map((o) => o.label)).toEqual([
      "Sternenlicht",
      "Mitternacht",
    ]);
  });

  /** The face is the theme in use, so the glyph must track `selected`. */
  it("shows the icon of the applied theme", () => {
    const fixture = TestBed.createComponent(ThemeSelectComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.current().value).toBe("starlight");

    fixture.componentRef.setInput("selected", "midnight");
    fixture.detectChanges();
    expect(fixture.componentInstance.current().value).toBe("midnight");
    expect(fixture.componentInstance.current().icon).toBe("pi pi-moon");
  });

  /**
   * A chooser, not a cycling toggle. Two themes could have been a toggle; the
   * list is expected to grow, and then "press until it comes round" is how you
   * reach the third one. The chip shows what is applied and opens the list.
   */
  it("offers every theme and applies the one picked", () => {
    const fixture = TestBed.createComponent(ThemeSelectComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.options().map((o) => o.value)).toEqual([
      "starlight",
      "midnight",
    ]);

    fixture.componentInstance.onChange("midnight");
    expect(fixture.componentInstance.selected()).toBe("midnight");
    // The chip's face follows what is applied, so it never lies about state.
    expect(fixture.componentInstance.current().value).toBe("midnight");
    expect(fixture.componentInstance.current().icon).toBe("pi pi-moon");
  });

  it("updates the selected model on change and ignores null", () => {
    const fixture = TestBed.createComponent(ThemeSelectComponent);
    fixture.detectChanges();

    fixture.componentInstance.onChange("midnight");
    expect(fixture.componentInstance.selected()).toBe("midnight");

    fixture.componentInstance.onChange(null);
    expect(fixture.componentInstance.selected()).toBe("midnight");
  });
});

describe("LangSelectComponent", () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [LangSelectComponent, TranslateModule.forRoot()],
    });
  });

  it("maps known codes to display names and unknown codes to uppercase", () => {
    const fixture = TestBed.createComponent(LangSelectComponent);
    fixture.componentRef.setInput("languages", ["en", "de", "vi"]);
    fixture.detectChanges();

    expect(fixture.componentInstance.options()).toEqual([
      { label: "English", value: "en" },
      { label: "Deutsch", value: "de" },
      { label: "VI", value: "vi" },
    ]);
  });

  it("shows the active code on the chip and full names in the chooser", () => {
    const fixture = TestBed.createComponent(LangSelectComponent);
    fixture.componentRef.setInput("languages", ["en", "de"]);
    fixture.detectChanges();

    // "DE" is the compact face; nobody should have to know what it expands to,
    // so the list carries the names.
    expect(fixture.componentInstance.currentCode()).toBe("EN");
    expect(fixture.componentInstance.options().map((o) => o.label)).toEqual([
      "English",
      "Deutsch",
    ]);

    fixture.componentInstance.onChange("de");
    expect(fixture.componentInstance.currentCode()).toBe("DE");
  });

  it("updates the selected model on change and ignores null", () => {
    const fixture = TestBed.createComponent(LangSelectComponent);
    fixture.detectChanges();

    fixture.componentInstance.onChange("de");
    expect(fixture.componentInstance.selected()).toBe("de");

    fixture.componentInstance.onChange(null);
    expect(fixture.componentInstance.selected()).toBe("de");
  });
});
