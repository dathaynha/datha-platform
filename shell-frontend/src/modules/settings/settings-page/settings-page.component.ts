import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
} from "@angular/core";
import { Router } from "@angular/router";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import {
  LangSelectComponent,
  ThemeSelectComponent,
  type DathaThemeId,
} from "@datha/platform-ui";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { ShellContextService } from "@services/implementations/shell-context.service";
import { environment } from "src/environments/environment";

interface SettingsCard {
  titleKey: string;
  descriptionKey: string;
  icon: string;
  route: string | null; // null = not a destination (see `control`)
  /**
   * Rendered inline instead of navigating. A preference with exactly one
   * control does not deserve a page of its own, and on a phone this card is
   * the *only* way to reach it — the toolbar drops both selects below `sm`.
   */
  control: "theme" | "lang" | null;
}

@Component({
  selector: "shell-settings-page",
  imports: [TranslateModule, ThemeSelectComponent, LangSelectComponent],
  templateUrl: "./settings-page.component.html",
  host: { class: "block h-full min-h-0 w-full flex-1 overflow-hidden" },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPageComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly shellContext = inject(ShellContextService);
  private readonly translate = inject(TranslateService);

  readonly cards: SettingsCard[] = [
    {
      titleKey: "SETTINGS.CARDS.NOTIFICATIONS.TITLE",
      descriptionKey: "SETTINGS.CARDS.NOTIFICATIONS.DESC",
      icon: "pi-bell",
      route: "/settings/notifications",
      control: null,
    },
    {
      titleKey: "SETTINGS.CARDS.APPEARANCE.TITLE",
      descriptionKey: "SETTINGS.CARDS.APPEARANCE.DESC",
      icon: "pi-palette",
      route: null,
      control: "theme",
    },
    {
      titleKey: "SETTINGS.CARDS.LANGUAGE.TITLE",
      descriptionKey: "SETTINGS.CARDS.LANGUAGE.DESC",
      icon: "pi-globe",
      route: null,
      control: "lang",
    },
  ];

  readonly languages = Object.keys(environment.localeMap);
  selectedLanguage = "en";
  selectedTheme: DathaThemeId = "starlight";

  ngOnInit(): void {
    const stored =
      localStorage.getItem(LOCAL_STORAGE_KEY.LANGUAGE) ||
      this.translate.currentLang ||
      "en";
    this.selectedLanguage = this.languages.includes(stored) ? stored : "en";
    this.selectedTheme = this.shellContext.currentThemeId;
  }

  // Both write through ShellContextService, which is the same owner the
  // toolbar's copies call — two callers of one setter, not a second mechanism.
  onLanguageChange(lang: string): void {
    if (!lang) return;
    this.shellContext.setLang(lang);
    this.selectedLanguage = lang;
  }

  onThemeChange(theme: DathaThemeId): void {
    if (!theme) return;
    this.shellContext.setTheme(theme);
    this.selectedTheme = theme;
  }

  open(card: SettingsCard): void {
    if (card.route) void this.router.navigateByUrl(card.route);
  }
}
