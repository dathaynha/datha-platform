import { Injectable } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { LOCAL_STORAGE_KEY } from "@constants/index";

/**
 * In-app theme bus for standalone mode: the toolbar's theme select writes here,
 * AppComponent reads it to put `.dark` on the app root.
 *
 * Hosted by the shell this never runs — the shell owns the theme and stamps the
 * document itself, and AppComponent is not bootstrapped at all.
 *
 * Replaces the theme half of the old MicroFrontendsService; the other half was
 * the pre-Module-Federation postMessage bridge, which had no sender left.
 */
@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly themeSubject = new BehaviorSubject<string | null>(
    localStorage.getItem(LOCAL_STORAGE_KEY.THEME),
  );

  readonly theme$ = this.themeSubject.asObservable();

  setTheme(theme: string): void {
    localStorage.setItem(LOCAL_STORAGE_KEY.THEME, theme);
    this.themeSubject.next(theme);
  }
}
