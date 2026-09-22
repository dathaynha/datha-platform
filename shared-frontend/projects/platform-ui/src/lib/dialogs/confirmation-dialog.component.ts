import { Component, inject } from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { ButtonModule } from "primeng/button";
import { DynamicDialogConfig, DynamicDialogRef } from "primeng/dynamicdialog";
import type { ConfirmDialogModel } from "./dialog.models";

/** Consumer i18n keys: DIALOG.CANCEL, DIALOG.CONFIRM. */
@Component({
  selector: "datha-confirmation-dialog",
  imports: [TranslateModule, ButtonModule],
  template: `
    <div class="datha-dialog datha-dialog--confirm">
      @if (title) {
        <h3 class="datha-dialog__title">{{ title }}</h3>
      }
      <div class="datha-dialog__body" [innerHTML]="message"></div>
      <div class="datha-dialog__actions">
        <p-button
          [label]="'DIALOG.CANCEL' | translate"
          [text]="true"
          (onClick)="onDismiss()"
        />
        <p-button
          [label]="'DIALOG.CONFIRM' | translate"
          (onClick)="onConfirm()"
        />
      </div>
    </div>
  `,
  styleUrls: ["./dialog.shared.scss"],
})
export class ConfirmationDialogComponent {
  readonly ref = inject(DynamicDialogRef);
  readonly config = inject(DynamicDialogConfig<ConfirmDialogModel>);

  readonly title = this.config.data?.title ?? "";
  readonly message = this.config.data?.message ?? "";

  onConfirm(): void {
    this.ref.close(true);
  }

  onDismiss(): void {
    this.ref.close(false);
  }
}
