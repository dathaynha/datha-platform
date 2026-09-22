import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import type { DirectoryUser } from "src/models/messenger.model";
import { PersonAvatarComponent } from "../person-avatar/person-avatar.component";

/**
 * The people picked so far, each removable.
 *
 * Shared by both places that select people — creating a group and adding to an
 * existing one — because they are the same act and were drifting apart the
 * moment the second one shipped without chips at all (dathq, 2026-09-14). The
 * same reasoning as `person-avatar`: one component, or three copies of the
 * same three rules.
 *
 * The chip *is* the remove control: label, picture and × are one target,
 * because a 10px × inside a chip is a miss waiting to happen.
 */
@Component({
  selector: "messenger-person-chips",
  imports: [TranslateModule, PersonAvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .chip {
        border: 1px solid var(--p-content-border-color);
        background: var(--p-content-background);
        color: var(--p-text-color);
      }

      .chip:hover {
        border-color: var(--p-primary-500);
        color: var(--p-primary-color);
      }

      .chip-avatar {
        display: inline-flex;
        height: 1.25rem;
        width: 1.25rem;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: linear-gradient(
          135deg,
          var(--p-primary-500),
          var(--p-primary-800)
        );
        color: var(--p-primary-contrast-color);
        font-size: 0.5625rem;
        font-weight: 600;
      }
    `,
  ],
  template: `
    @if (people().length > 0) {
      <!-- Capped and scrollable: a dozen chips would otherwise push the list
           they were picked from off the bottom of the dialog. -->
      <ul
        class="m-0 flex max-h-24 shrink-0 list-none flex-wrap gap-1.5 overflow-y-auto p-0"
        role="list"
      >
        @for (person of people(); track person.ownerId) {
          <li>
            <button
              type="button"
              class="chip flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2"
              data-testid="group-chip"
              [attr.aria-label]="
                ('MESSENGER.GROUP.REMOVE' | translate) +
                ' ' +
                person.displayName
              "
              (click)="remove.emit(person)"
            >
              <span class="chip-avatar shrink-0" aria-hidden="true">
                <messenger-avatar
                  [url]="person.pictureUrl"
                  [name]="person.displayName"
                />
              </span>
              <span class="max-w-[8rem] truncate text-[0.75rem] font-medium">{{
                person.displayName
              }}</span>
              <i class="pi pi-times text-[0.625rem]" aria-hidden="true"></i>
            </button>
          </li>
        }
      </ul>
    }
  `,
})
export class PersonChipsComponent {
  readonly people = input<readonly DirectoryUser[]>([]);
  readonly remove = output<DirectoryUser>();
}
