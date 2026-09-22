import { Injectable } from "@angular/core";
import { Router } from "@angular/router";
import { HelpDialogComponent } from "@datha/platform-ui";
import type { HelpDialogData } from "@models/dialog.model";
import { User } from "@models/index";
import { TranslateService } from "@ngx-translate/core";
import { DialogService } from "primeng/dynamicdialog";
import { BehaviorSubject } from "rxjs";

@Injectable({
  providedIn: "root",
})
export class CommonService {
  private loadingSubject = new BehaviorSubject<boolean>(false);
  private currentUserSubject = new BehaviorSubject<User | null>(null);

  loading$ = this.loadingSubject.asObservable();
  currentUser$ = this.currentUserSubject.asObservable();

  private readonly helpData: Record<
    string,
    { title: string; message: string }
  > = {
    dashboard: {
      title: "DASHBOARD.TITLE",
      message: "DASHBOARD.HELP",
    },
  };

  constructor(
    private dialogService: DialogService,
    public translate: TranslateService,
    private router: Router,
  ) {}

  setLoading(loading: boolean) {
    this.loadingSubject.next(loading);
  }

  setCurrentUser(user: User) {
    this.currentUserSubject.next(user);
  }

  getCurrentUser(): User | null {
    return this.currentUserSubject.getValue();
  }

  showHelp() {
    const currentUrl = this.router.url;
    const helpKey =
      currentUrl === "/" || currentUrl === "" ? "dashboard" : null;
    if (!helpKey) {
      return;
    }
    const helpContent = this.helpData[helpKey];
    if (!helpContent) {
      return;
    }
    this.dialogService.open(HelpDialogComponent, {
      header: this.translate.instant(helpContent.title),
      data: {
        message: this.translate.instant(helpContent.message),
      } satisfies HelpDialogData,
      width: "min(520px, 92vw)",
      modal: true,
      closable: true,
      duplicate: true,
    });
  }
}
