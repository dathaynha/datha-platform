import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  model,
  OnDestroy,
  OnInit,
  signal,
} from "@angular/core";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { ButtonModule } from "primeng/button";
import { Popover, PopoverModule } from "primeng/popover";
import { alignPopoverToTrigger, dismissOnOutsidePress } from "./align-popover";
import { Subscription } from "rxjs";
import {
  DATHA_THEME_ICONS,
  DATHA_THEME_IDS,
  type DathaThemeId,
} from "../theme/datha-theme.model";

interface ThemeOption {
  label: string;
  value: DathaThemeId;
  icon: string;
}

/**
 * Theme picker for shell toolbars.
 *
 * A **chip that opens a chooser** — not a dropdown, and deliberately not a
 * cycling toggle. The dropdown went first: a select spent ~150px saying which
 * theme was active, and with its language twin it wrapped every remote's
 * header onto three rows on a phone. A toggle that advanced on each press was
 * the obvious replacement and is wrong, because the theme list is expected to
 * grow and cycling makes reaching the third option a matter of pressing until
 * it comes round.
 *
 * So the chip carries the *current* theme's icon and opens a list of every
 * theme, which stays correct at two and at ten. Trigger and overlay are the
 * ones the profile popover already uses, so the toolbar is one row of chips.
 *
 * Labels come from the consumer's `THEME.<ID>` keys and are re-resolved on
 * language change; `THEME.LABEL` names the control itself. Two-way bind
 * `selected`; apply via your shell context.
 */
@Component({
  selector: "datha-theme-select",
  imports: [ButtonModule, PopoverModule, TranslateModule],
  template: `
    <span #anchor class="datha-chip-anchor">
      <p-button
        type="button"
        [rounded]="true"
        [outlined]="true"
        styleClass="datha-profile-trigger"
        [icon]="current().icon"
        [ariaLabel]="'THEME.LABEL' | translate"
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
        [attr.aria-label]="'THEME.LABEL' | translate"
      >
        @for (option of options(); track option.value) {
          <p-button
            type="button"
            class="w-full"
            [fluid]="true"
            [text]="true"
            iconPos="left"
            [icon]="option.icon"
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
export class ThemeSelectComponent implements OnInit, OnDestroy {
  private readonly translate = inject(TranslateService);

  readonly selected = model<DathaThemeId>("starlight");
  readonly inputId = model<string>("datha-theme");

  readonly options = signal<ThemeOption[]>([]);

  /** The option on the chip's face — what is applied right now. */
  readonly current = computed<ThemeOption>(() => {
    const options = this.options();
    const match = options.find((option) => option.value === this.selected());
    return (
      match ??
      options[0] ?? {
        label: "",
        value: this.selected(),
        icon: DATHA_THEME_ICONS[this.selected()] ?? "",
      }
    );
  });

  private langSub?: Subscription;

  ngOnInit(): void {
    this.rebuildOptions();
    this.langSub = this.translate.onLangChange.subscribe(() =>
      this.rebuildOptions(),
    );
  }

  ngOnDestroy(): void {
    this.langSub?.unsubscribe();
  }

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

  /** Applies a theme and closes the chooser, which has answered its question. */
  pick(theme: DathaThemeId, panel: Popover): void {
    this.onChange(theme);
    panel.hide();
  }

  onChange(theme: DathaThemeId | null): void {
    if (!theme) return;
    this.selected.set(theme);
  }

  private rebuildOptions(): void {
    this.options.set(
      DATHA_THEME_IDS.map((id) => ({
        value: id,
        label: this.translate.instant(`THEME.${id.toUpperCase()}`),
        icon: DATHA_THEME_ICONS[id],
      })),
    );
  }
}
