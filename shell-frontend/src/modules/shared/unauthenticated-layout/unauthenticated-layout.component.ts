import { Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import {
  LangSelectComponent,
  ThemeSelectComponent,
  type DathaThemeId,
} from "@datha/platform-ui";
import { TranslateService } from "@ngx-translate/core";
import { ShellContextService } from "@services/implementations/shell-context.service";
import { ToolbarModule } from "primeng/toolbar";
import { environment } from "src/environments/environment";

@Component({
  selector: "unauthenticated-layout",
  imports: [
    RouterOutlet,
    ToolbarModule,
    ThemeSelectComponent,
    LangSelectComponent,
  ],
  templateUrl: "./unauthenticated-layout.component.html",
  styleUrls: ["./unauthenticated-layout.component.scss"],
  host: { class: "block" },
})
export class UnauthenticatedLayoutComponent {
  private readonly translate = inject(TranslateService);
  private readonly shellContext = inject(ShellContextService);

  readonly languages = Object.keys(environment.localeMap);

  selectedLanguage: string =
    localStorage.getItem(LOCAL_STORAGE_KEY.LANGUAGE) ||
    this.translate.currentLang ||
    "en";

  selectedTheme: DathaThemeId = this.shellContext.currentThemeId;

  onLanguageChange(lang: string): void {
    if (!lang) return;
    this.translate.use(lang);
    localStorage.setItem(LOCAL_STORAGE_KEY.LANGUAGE, lang);
    this.selectedLanguage = lang;
  }

  onThemeChange(theme: DathaThemeId): void {
    if (!theme) return;
    this.shellContext.setTheme(theme);
    this.selectedTheme = theme;
  }
}
