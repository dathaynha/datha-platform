import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
} from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { ButtonModule } from "primeng/button";
import { Popover, PopoverModule } from "primeng/popover";
import { alignPopoverToTrigger, dismissOnOutsidePress } from "./align-popover";

/** Display names for platform languages; codes without an entry fall back to uppercase. */
export const DATHA_LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  de: "Deutsch",
};

interface LangOption {
  label: string;
  value: string;
}

/**
 * Language picker for shell toolbars.
 *
 * A **chip that opens a chooser**, for the same reasons as its theme twin: the
 * old select cost ~150px, and a cycling toggle would have made the third
 * language reachable only by pressing through the others. The enabled set is
 * the consumer's to decide and is expected to grow.
 *
 * The chip's face is the active code, which is what compact language switchers
 * show everywhere; the chooser lists full names, so nobody has to know that
 * "DE" is Deutsch. `LANGUAGE.LABEL` names the control itself.
 *
 * Pass the enabled codes (e.g. from the consumer's environment locale map);
 * two-way bind `selected`.
 */
@Component({
  selector: "datha-lang-select",
  imports: [ButtonModule, PopoverModule, TranslateModule],
  template: `
    <span #anchor class="datha-chip-anchor">
      <p-button
        type="button"
        [rounded]="true"
        [outlined]="true"
        styleClass="datha-profile-trigger datha-lang-trigger"
        [label]="currentCode()"
        [ariaLabel]="'LANGUAGE.LABEL' | translate"
        (onClick)="panel.toggle($event)"
      />
    </span>
    <p-popover
      #panel
      [dismissable]="true"
      styleClass="datha-chooser-panel"
      (onShow)="onShow(panel, anchor)"
      (onHide)="onHide()"
    >
      <div
        class="datha-chooser"
        role="listbox"
        [attr.aria-label]="'LANGUAGE.LABEL' | translate"
      >
        @for (option of options(); track option.value) {
          <p-button
            type="button"
            class="w-full"
            [fluid]="true"
            [text]="true"
            [label]="option.label"
            [severity]="option.value === selected() ? 'primary' : 'secondary'"
            [attr.aria-current]="option.value === selected() ? 'true' : null"
            (onClick)="pick(option.value, panel)"
          />
        }
      </div>
    </p-popover>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }

      .datha-chip-anchor {
        display: inline-flex;
      }

      .datha-chooser {
        display: flex;
        min-width: 10rem;
        flex-direction: column;
        gap: 0.25rem;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LangSelectComponent {
  readonly languages = input<string[]>(["en"]);
  readonly selected = model<string>("en");
  readonly inputId = model<string>("datha-lang");

  readonly options = computed<LangOption[]>(() =>
    this.languages().map((code) => ({
      label: DATHA_LANGUAGE_LABELS[code] ?? code.toUpperCase(),
      value: code,
    })),
  );

  /** The face of the chip: the active code, as compact switchers show it. */
  readonly currentCode = computed(() => this.selected().toUpperCase());

  private release?: () => void;

  /**
   * Aligns the menu to its chip and makes it the only one on screen.
   *
   * The dismissal is not belt-and-braces: PrimeNG's own outside-click misses
   * the messenger header widget, which re-dispatches its trigger's click, so
   * two menus sat open side by side.
   */
  protected onShow(panel: Popover, anchor: HTMLElement): void {
    alignPopoverToTrigger(panel, anchor);
    this.release?.();
    this.release = dismissOnOutsidePress(panel, (target) => {
      const container = panel.container;
      return (container?.contains(target) ?? false) || anchor.contains(target);
    });
  }

  protected onHide(): void {
    this.release?.();
    this.release = undefined;
  }

  /** Applies a language and closes the chooser. */
  pick(lang: string, panel: Popover): void {
    this.onChange(lang);
    panel.hide();
  }

  onChange(lang: string | null): void {
    if (!lang) return;
    this.selected.set(lang);
  }
}
