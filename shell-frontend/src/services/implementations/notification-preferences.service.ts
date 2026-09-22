import { HttpClient, HttpContext } from "@angular/common/http";
import { Injectable, inject, signal } from "@angular/core";
import { TranslateService } from "@ngx-translate/core";
import { firstValueFrom } from "rxjs";
import { SKIP_GLOBAL_ERROR_DIALOG } from "src/interceptors/http-context.tokens";
import type { NotificationPreferences } from "@models/index";
import { environment } from "src/environments/environment";

/**
 * Notification channel preferences (phase 3 wave 0). Optimistic saves with
 * rollback; `locale` is never user-edited — it mirrors the active UI language
 * so the server can render push/email content in the right language.
 */
@Injectable({ providedIn: "root" })
export class NotificationPreferencesService {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly url = `${environment.gateway.baseUrl}/api/notifications/preferences`;
  private readonly silentContext = new HttpContext().set(
    SKIP_GLOBAL_ERROR_DIALOG,
    true,
  );

  readonly preferences = signal<NotificationPreferences | null>(null);
  readonly loading = signal(false);
  readonly saveError = signal(false);

  constructor() {
    // Keep the stored locale in sync with the active UI language.
    this.translate.onLangChange.subscribe((event) => {
      const current = this.preferences();
      if (current && current.locale !== event.lang) {
        void this.save({ locale: event.lang });
      }
    });
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const prefs = await firstValueFrom(
        this.http.get<NotificationPreferences>(this.url, {
          context: this.silentContext,
        }),
      );
      this.preferences.set(prefs);
      this.saveError.set(false);
    } catch {
      this.saveError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Optimistic partial update — rolls back and flags saveError on failure. */
  async save(patch: Partial<NotificationPreferences>): Promise<void> {
    const previous = this.preferences();
    if (!previous) return;

    const next: NotificationPreferences = {
      ...previous,
      ...patch,
      locale: patch.locale ?? this.translate.currentLang ?? previous.locale,
    };
    this.preferences.set(next);

    try {
      const stored = await firstValueFrom(
        this.http.put<NotificationPreferences>(this.url, next, {
          context: this.silentContext,
        }),
      );
      this.preferences.set(stored);
      this.saveError.set(false);
    } catch {
      this.preferences.set(previous);
      this.saveError.set(true);
    }
  }
}
