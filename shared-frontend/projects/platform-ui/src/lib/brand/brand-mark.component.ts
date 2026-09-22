import { ChangeDetectionStrategy, Component } from "@angular/core";

/**
 * Platform brand mark (the dual-crescent swirl). Inherits `currentColor`;
 * size it from the consumer via host classes (e.g. `class="h-7 w-7"`).
 */
@Component({
  selector: "datha-brand-mark",
  template: `
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M8 18c0-4.5 3.5-8 8-8v4c-2.2 0-4 1.8-4 4s1.8 4 4 4v4c-4.5 0-8-3.5-8-8z"
        fill="currentColor"
        opacity=".35"
      />
      <path
        d="M16 10c4.4 0 8 3.6 8 8s-3.6 8-8 8v-4c2.2 0 4-1.8 4-4s-1.8-4-4-4v-4z"
        fill="currentColor"
      />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
    }

    svg {
      height: 100%;
      width: 100%;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrandMarkComponent {}
