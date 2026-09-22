import { Pipe, PipeTransform, inject } from "@angular/core";
import { TranslateService } from "@ngx-translate/core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "5 min ago"-style timestamps for the notification drawer. Impure so language
 * switches re-render; the computation is trivial and lists are small (≤ pages
 * of 20). Falls back to a locale date beyond 7 days.
 */
@Pipe({ name: "relativeTime", pure: false })
export class RelativeTimePipe implements PipeTransform {
  private readonly translate = inject(TranslateService);

  transform(isoDate: string): string {
    const elapsed = Date.now() - new Date(isoDate).getTime();

    if (elapsed < MINUTE) {
      return this.translate.instant("TIME.JUST_NOW");
    }
    if (elapsed < HOUR) {
      return this.translate.instant("TIME.MINUTES_AGO", {
        count: Math.floor(elapsed / MINUTE),
      });
    }
    if (elapsed < DAY) {
      return this.translate.instant("TIME.HOURS_AGO", {
        count: Math.floor(elapsed / HOUR),
      });
    }
    if (elapsed < 7 * DAY) {
      return this.translate.instant("TIME.DAYS_AGO", {
        count: Math.floor(elapsed / DAY),
      });
    }
    return new Date(isoDate).toLocaleDateString();
  }
}
