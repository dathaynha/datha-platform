import { DatePipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  inject,
  signal,
} from "@angular/core";
import { Router } from "@angular/router";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { MessageService } from "primeng/api";
import { ButtonModule } from "primeng/button";
import { DrawerModule } from "primeng/drawer";
import { sweepOrphanedDrawerMasks } from "@modules/shared/drawer-overlay";
import { ToastModule } from "primeng/toast";
import type { Subscription } from "rxjs";
import type { NotificationSeverity, PlatformNotification } from "@models/index";
import { RelativeTimePipe } from "@pipes/relative-time.pipe";
import { NotificationsService } from "@services/implementations/notifications.service";

const TOAST_SEVERITY: Record<NotificationSeverity, string> = {
  info: "info",
  warning: "warn",
  critical: "error",
};
const TOAST_LIFE_MS = 5_000;

@Component({
  selector: "shell-notification-bell",
  imports: [
    DatePipe,
    RelativeTimePipe,
    TranslateModule,
    ButtonModule,
    DrawerModule,
    ToastModule,
  ],
  providers: [MessageService],
  templateUrl: "./notification-bell.component.html",
  styleUrls: ["./notification-bell.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NotificationBellComponent implements OnInit, OnDestroy {
  readonly notificationsService = inject(NotificationsService);
  private readonly router = inject(Router);
  private readonly messageService = inject(MessageService);
  private readonly translate = inject(TranslateService);

  readonly drawerVisible = signal(false);

  private pushedSub: Subscription | null = null;

  ngOnInit(): void {
    this.notificationsService.connect();
    this.pushedSub = this.notificationsService.pushed$.subscribe(
      (notification) => this.showToast(notification),
    );
  }

  ngOnDestroy(): void {
    this.pushedSub?.unsubscribe();
    this.notificationsService.disconnect();
  }

  private showToast(notification: PlatformNotification): void {
    // The drawer already shows the new card — no toast on top of it.
    if (this.drawerVisible()) return;
    this.messageService.add({
      key: "shell-notifications",
      severity: TOAST_SEVERITY[notification.severity],
      summary: this.translate.instant(
        notification.titleKey,
        notification.params,
      ),
      detail: this.translate.instant(notification.bodyKey, notification.params),
      life: TOAST_LIFE_MS,
    });
  }

  openSettings(): void {
    this.closeDrawerAndNavigate("/settings/notifications");
  }

  private closeDrawerAndNavigate(url: string): void {
    this.drawerVisible.set(false);
    void this.router.navigateByUrl(url);
    sweepOrphanedDrawerMasks(() => this.drawerVisible());
  }

  openDrawer(): void {
    this.drawerVisible.set(true);
    // Attention-first (GitHub pattern): land on Unread when something is unread.
    this.notificationsService.unreadOnly.set(
      this.notificationsService.unreadCount() > 0,
    );
    void this.notificationsService.loadNotifications();
  }

  retryLoad(): void {
    void this.notificationsService.loadNotifications();
  }

  setFilter(unreadOnly: boolean): void {
    void this.notificationsService.setUnreadOnly(unreadOnly);
  }

  onNotificationClick(notification: PlatformNotification): void {
    if (!notification.readAt) {
      void this.notificationsService.markRead(notification.id);
    }
    if (notification.link) {
      this.closeDrawerAndNavigate(notification.link);
    }
  }

  toggleReadState(event: Event, notification: PlatformNotification): void {
    event.stopPropagation();
    if (notification.readAt) {
      void this.notificationsService.markUnread(notification.id);
    } else {
      void this.notificationsService.markRead(notification.id);
    }
  }

  markAllRead(): void {
    void this.notificationsService.markAllRead();
  }

  showMore(): void {
    void this.notificationsService.loadMore();
  }

  severityLabelKey(notification: PlatformNotification): string {
    switch (notification.severity) {
      case "critical":
        return "NOTIFICATIONS.SEVERITY.CRITICAL";
      case "warning":
        return "NOTIFICATIONS.SEVERITY.WARNING";
      default:
        return "NOTIFICATIONS.SEVERITY.INFO";
    }
  }
}
