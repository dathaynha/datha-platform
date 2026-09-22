import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { SelectModule } from "primeng/select";
import { ToggleSwitchModule } from "primeng/toggleswitch";
import type { NotificationSeverity } from "@models/index";
import { NotificationPreferencesService } from "@services/implementations/notification-preferences.service";
import { NotificationPushService } from "@services/implementations/notification-push.service";

@Component({
  selector: "shell-notification-preferences-page",
  imports: [
    FormsModule,
    RouterLink,
    TranslateModule,
    SelectModule,
    ToggleSwitchModule,
  ],
  templateUrl: "./notification-preferences-page.component.html",
  styleUrls: ["./notification-preferences-page.component.scss"],
  host: { class: "block h-full min-h-0 w-full flex-1 overflow-hidden" },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationPreferencesPageComponent implements OnInit {
  readonly preferencesService = inject(NotificationPreferencesService);
  private readonly pushService = inject(NotificationPushService);
  private readonly translate = inject(TranslateService);
  private readonly langChange = toSignal(this.translate.onLangChange);

  /** i18n key describing why push could not be enabled (null = no issue). */
  readonly pushIssueKey = signal<string | null>(null);

  // Pre-translated `label` (not a template pipe): p-select derives each
  // option's aria-label from optionLabel — objects without it are announced
  // as "[object Object]" to screen readers.
  readonly severityOptions = computed(() => {
    this.langChange();
    return (["info", "warning", "critical"] as NotificationSeverity[]).map(
      (value) => ({
        label: this.translate.instant(
          `NOTIFICATIONS.SEVERITY.${value.toUpperCase()}`,
        ) as string,
        value,
      }),
    );
  });

  ngOnInit(): void {
    void this.preferencesService.load();
  }

  setPushEnabled(enabled: boolean): void {
    void this.togglePush(enabled);
  }

  private static readonly PUSH_ISSUE_KEYS: Record<string, string> = {
    denied: "SETTINGS.NOTIFICATIONS.PUSH_BLOCKED",
    dismissed: "SETTINGS.NOTIFICATIONS.PUSH_DISMISSED",
    unsupported: "SETTINGS.NOTIFICATIONS.PUSH_UNSUPPORTED",
    error: "SETTINGS.NOTIFICATIONS.PUSH_ERROR",
  };

  private async togglePush(enabled: boolean): Promise<void> {
    this.pushIssueKey.set(null);
    if (enabled) {
      // Browser subscription first — only persist the preference when the
      // user actually granted permission and a subscription exists.
      const outcome = await this.pushService
        .enable()
        .catch(() => "error" as const);
      if (outcome !== "granted") {
        this.pushIssueKey.set(
          NotificationPreferencesPageComponent.PUSH_ISSUE_KEYS[outcome] ??
            "SETTINGS.NOTIFICATIONS.PUSH_ERROR",
        );
        // Re-emit the unchanged preferences so the toggle snaps back to off.
        const current = this.preferencesService.preferences();
        if (current) this.preferencesService.preferences.set({ ...current });
        return;
      }
      await this.preferencesService.save({ pushEnabled: true });
      return;
    }
    await this.pushService.disable().catch(() => undefined);
    await this.preferencesService.save({ pushEnabled: false });
  }

  setPushMinSeverity(severity: NotificationSeverity): void {
    void this.preferencesService.save({ pushMinSeverity: severity });
  }

  setEmailDigest(enabled: boolean): void {
    void this.preferencesService.save({ emailDigest: enabled });
  }
}
