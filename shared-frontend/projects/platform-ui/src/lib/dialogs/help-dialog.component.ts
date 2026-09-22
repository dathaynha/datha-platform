import { Component, inject } from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { ButtonModule } from "primeng/button";
import { DynamicDialogConfig, DynamicDialogRef } from "primeng/dynamicdialog";
import type { HelpDialogData } from "./dialog.models";

/** Consumer i18n key: DIALOG.GOT_IT — named apart from the panel X ("Close"). */
@Component({
  selector: "datha-help-dialog",
  imports: [TranslateModule, ButtonModule],
  template: `
    <div class="datha-dialog__prose" [innerHTML]="message"></div>
    <div class="datha-dialog__actions datha-dialog__actions--spaced">
      <p-button [label]="'DIALOG.GOT_IT' | translate" (onClick)="onDismiss()" />
    </div>
  `,
  styleUrls: ["./dialog.shared.scss"],
  host: { class: "block" },
})
export class HelpDialogComponent {
  readonly ref = inject(DynamicDialogRef);
  readonly config = inject(DynamicDialogConfig<HelpDialogData>);

  readonly message = this.config.data?.message ?? "";

  onDismiss(): void {
    this.ref.close();
  }
}
