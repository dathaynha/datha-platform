import { ChangeDetectionStrategy, Component } from "@angular/core";
import { Router } from "@angular/router";
import {
  appDescriptionKey,
  appNameKey,
  type AppDescriptor,
} from "@models/index";
import { TranslateModule } from "@ngx-translate/core";
import { environment } from "src/environments/environment";

@Component({
  selector: "app-home-page",
  imports: [TranslateModule],
  templateUrl: "./home-page.component.html",
  host: { class: "block h-full min-h-0 w-full flex-1 overflow-hidden" },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomePageComponent {
  readonly apps: AppDescriptor[] =
    (environment as { apps?: AppDescriptor[] }).apps ?? [];

  readonly nameKey = appNameKey;
  readonly descriptionKey = appDescriptionKey;

  constructor(private router: Router) {}

  openApp(app: AppDescriptor): void {
    void this.router.navigate([app.route]);
  }
}
