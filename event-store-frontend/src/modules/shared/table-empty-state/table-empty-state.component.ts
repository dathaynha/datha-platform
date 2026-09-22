import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { ButtonModule } from "primeng/button";

@Component({
  selector: "es-table-empty-state",
  imports: [TranslateModule, ButtonModule],
  templateUrl: "./table-empty-state.component.html",
  styleUrls: ["./table-empty-state.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "es-table-empty-host",
  },
})
export class TableEmptyStateComponent {
  readonly titleKey = input.required<string>();
  readonly hintKey = input<string | undefined>(undefined);
  readonly icon = input("pi-inbox");
  readonly loading = input(false);
  readonly clearLabelKey = input("EVENTS_PAGE.FILTERS.CLEAR");
  readonly showClearAction = input(false);

  readonly clearAction = output<void>();
}
