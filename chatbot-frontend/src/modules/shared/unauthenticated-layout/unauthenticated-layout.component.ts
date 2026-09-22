import { Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { LOCAL_STORAGE_KEY } from "@constants/index";
import { LangSelectComponent, SubHeaderComponent } from "@datha/platform-ui";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { environment } from "src/environments/environment";
import { ButtonModule } from "primeng/button";

@Component({
  selector: "unauthenticated-layout",
  imports: [
    RouterOutlet,
    TranslateModule,
    ButtonModule,
    SubHeaderComponent,
    LangSelectComponent,
  ],
  templateUrl: "./unauthenticated-layout.component.html",
  styleUrls: ["./unauthenticated-layout.component.scss"],
  host: { class: "block" },
})
export class UnauthenticatedLayoutComponent {
  private readonly translate = inject(TranslateService);

  readonly languages = Object.keys(environment.localeMap);

  selectedLanguage: string =
    localStorage.getItem(LOCAL_STORAGE_KEY.LANGUAGE) ||
    this.translate.currentLang ||
    "en";

  onLanguageChange(lang: string): void {
    if (!lang) return;
    this.translate.use(lang);
    localStorage.setItem(LOCAL_STORAGE_KEY.LANGUAGE, lang);
    this.selectedLanguage = lang;
  }

  sendEmail(): void {
    const subject = this.translate.instant("EMAIL.SUBJECT");
    const body = this.translate.instant("EMAIL.BODY", {
      applicationName: environment.email.applicationName,
    });
    window.location.href = `mailto:${environment.email.recipients.join(",")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
}
