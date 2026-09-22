import { TestBed } from "@angular/core/testing";
import { TranslateModule } from "@ngx-translate/core";
import { DynamicDialogConfig, DynamicDialogRef } from "primeng/dynamicdialog";
import { ConfirmationDialogComponent } from "./confirmation-dialog.component";
import { HelpDialogComponent } from "./help-dialog.component";
import { MessageDialogComponent } from "./message-dialog.component";

function configureDialog<T>(component: unknown, data: T): DynamicDialogRef {
  const ref = jasmine.createSpyObj<DynamicDialogRef>("DynamicDialogRef", [
    "close",
  ]);
  TestBed.configureTestingModule({
    imports: [component as never, TranslateModule.forRoot()],
    providers: [
      { provide: DynamicDialogRef, useValue: ref },
      { provide: DynamicDialogConfig, useValue: { data } },
    ],
  });
  return ref;
}

describe("MessageDialogComponent", () => {
  it("renders the plain message and closes", () => {
    const ref = configureDialog(MessageDialogComponent, {
      message: "<b>saved</b>",
    });
    const fixture = TestBed.createComponent(MessageDialogComponent);
    fixture.detectChanges();

    const body: HTMLElement = fixture.nativeElement.querySelector(
      ".datha-dialog__body",
    );
    expect(body.innerHTML).toContain("saved");

    fixture.componentInstance.onClose();
    expect(ref.close).toHaveBeenCalledWith();
  });

  it("sets the config header from titleKey", () => {
    configureDialog(MessageDialogComponent, { titleKey: "T", messageKey: "M" });
    const fixture = TestBed.createComponent(MessageDialogComponent);
    fixture.detectChanges();

    expect(TestBed.inject(DynamicDialogConfig).header).toBe("T");
  });
});

describe("ConfirmationDialogComponent", () => {
  it("closes true on confirm and false on dismiss", () => {
    const ref = configureDialog(ConfirmationDialogComponent, {
      title: "Sure?",
      message: "really",
    });
    const fixture = TestBed.createComponent(ConfirmationDialogComponent);
    fixture.detectChanges();

    fixture.componentInstance.onConfirm();
    expect(ref.close).toHaveBeenCalledWith(true);
    fixture.componentInstance.onDismiss();
    expect(ref.close).toHaveBeenCalledWith(false);
  });
});

describe("HelpDialogComponent", () => {
  it("renders message HTML and closes", () => {
    const ref = configureDialog(HelpDialogComponent, { message: "<p>hi</p>" });
    const fixture = TestBed.createComponent(HelpDialogComponent);
    fixture.detectChanges();

    const prose: HTMLElement = fixture.nativeElement.querySelector(
      ".datha-dialog__prose",
    );
    expect(prose.innerHTML).toContain("hi");

    fixture.componentInstance.onDismiss();
    expect(ref.close).toHaveBeenCalledWith();
  });
});
