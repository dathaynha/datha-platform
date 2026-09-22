import { Component, inject, OnDestroy, OnInit } from "@angular/core";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { ButtonModule } from "primeng/button";
import { DynamicDialogConfig, DynamicDialogRef } from "primeng/dynamicdialog";
import { Subscription } from "rxjs";
import type { MessageDialogData } from "./dialog.models";

/** Consumer i18n key: DIALOG.OK — named apart from the panel X ("Close"). */
@Component({
  selector: "datha-message-dialog",
  imports: [TranslateModule, ButtonModule],
  template: `
    <div class="datha-dialog">
      <div
        class="datha-dialog__body"
        [innerHTML]="messageKey ? (messageKey | translate) : message"
      ></div>
      <div class="datha-dialog__actions">
        <p-button [label]="'DIALOG.OK' | translate" (onClick)="onClose()" />
      </div>
    </div>
  `,
  styleUrls: ["./dialog.shared.scss"],
})
export class MessageDialogComponent implements OnInit, OnDestroy {
  readonly ref = inject(DynamicDialogRef);
  readonly config = inject(DynamicDialogConfig<MessageDialogData>);
  private readonly translate = inject(TranslateService);

  readonly titleKey = this.config.data?.titleKey;
  readonly messageKey = this.config.data?.messageKey;
  readonly message = this.config.data?.message ?? "";

  private langSub?: Subscription;

  ngOnInit(): void {
    if (this.titleKey) {
      this.config.header = this.translate.instant(this.titleKey);
      this.langSub = this.translate.onLangChange.subscribe(() => {
        this.config.header = this.translate.instant(this.titleKey!);
      });
    }
  }

  ngOnDestroy(): void {
    this.langSub?.unsubscribe();
  }

  onClose(): void {
    this.ref.close();
  }
}
