import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from "@angular/core";

/**
 * One person's picture, anywhere a person is shown.
 *
 * Every surface that names someone had its own copy of the same three rules —
 * show the directory picture, fall back to the initial, survive a picture that
 * will not load — and each copy drifted: the conversation list had no error
 * handler at all, so a Google avatar that failed left a broken-image icon
 * (dathq, 2026-09-11). One component is the rule: see
 * `.claude/rules/working-agreement.md` § People are shown with their avatar.
 *
 * Size and shape belong to the caller's wrapper: the host fills it, so a
 * 1.5rem message avatar and a 6rem call tile use the same component.
 */
@Component({
  selector: "messenger-avatar",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "person-avatar" },
  styles: [
    `
      /* The wrapper owns size, colour and shape; inherit picks its radius up
         so a round wrapper clips the picture round without restating it. */
      :host {
        display: inline-flex;
        height: 100%;
        width: 100%;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        border-radius: inherit;
      }

      img {
        height: 100%;
        width: 100%;
        object-fit: cover;
      }
    `,
  ],
  template: `
    @if (picture(); as url) {
      <!-- Google's lh3.googleusercontent.com pictures do not always load in a
           third-party context, hence both the referrer policy and the fallback. -->
      <img
        [src]="url"
        alt=""
        referrerpolicy="no-referrer"
        (error)="onError(url)"
      />
    } @else {
      <span aria-hidden="true">{{ initial() }}</span>
    }
  `,
})
export class PersonAvatarComponent {
  /** Directory picture. Empty is normal — most people have none. */
  readonly url = input("");
  /** Display name, used for the initial when there is no picture. */
  readonly name = input("");
  /**
   * Overrides the derived initial.
   *
   * For callers that resolve it themselves — the call dock reads the directory
   * only, deliberately never `displayName`, because that falls back to the raw
   * owner id and a Google account then shows as "G".
   */
  readonly initialOverride = input("");

  private readonly failed = signal<ReadonlySet<string>>(new Set());

  protected readonly picture = computed(() => {
    const url = this.url();
    return url && !this.failed().has(url) ? url : "";
  });

  /** The first letter, or a dot when the name is not known yet. */
  protected readonly initial = computed(() => {
    const override = this.initialOverride().trim();
    if (override) return override;
    const name = this.name().trim();
    return name ? name.charAt(0).toUpperCase() : "·";
  });

  protected onError(url: string): void {
    this.failed.update((current) => new Set(current).add(url));
  }
}
