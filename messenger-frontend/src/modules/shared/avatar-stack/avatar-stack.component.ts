import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from "@angular/core";
import { PersonAvatarComponent } from "../person-avatar/person-avatar.component";

/** One face in a stack: enough to render a picture or fall back to a letter. */
export interface AvatarFace {
  ownerId: string;
  url: string;
  name: string;
  /**
   * The letter to show when there is no picture, resolved from the directory.
   *
   * Separate from `name` because a display name falls back to the raw owner id,
   * and every id here starts `google_` — so deriving the letter from it renders
   * everybody as "G" (`.claude/rules/working-agreement.md` § the avatar rule).
   * Empty is correct when the directory has not answered yet: the component
   * shows a neutral dot rather than a wrong letter.
   */
  initial: string;
}

/**
 * The faces of a conversation — one person or a group.
 *
 * A group names several people, so the avatar rule
 * (`.claude/rules/working-agreement.md` § People are shown with their avatar)
 * applies to all of them: a group tile shows member pictures the way Messenger
 * and WhatsApp do, not a letter derived from a title that may not even exist.
 *
 * One face renders exactly as a single avatar always has, so every caller can
 * hand over a list without branching on the conversation type.
 *
 * Two is the cap on purpose. At the 2.25rem the list uses, a third face is
 * smaller than the letter inside it, and a "+4" badge is a number nobody reads
 * where a picture is doing the identifying.
 */
@Component({
  selector: "messenger-avatar-stack",
  imports: [PersonAvatarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        position: relative;
        display: inline-flex;
        height: 100%;
        width: 100%;
        align-items: center;
        justify-content: center;
        border-radius: inherit;
      }

      /* A single face keeps the wrapper's own shape and size — the stacked
         layout below must not apply, or every direct thread shrinks. */
      .single {
        height: 100%;
        width: 100%;
        border-radius: inherit;
        overflow: hidden;
      }

      .stacked {
        position: absolute;
        height: 68%;
        width: 68%;
        border-radius: 999px;
        overflow: hidden;
        /* The ring separates overlapping faces; it reads as a gap rather than
           as a border because it is painted in the panel's own colour. */
        box-shadow: 0 0 0 2px var(--chats-avatar-ring, #fff);
        background: var(--chats-accent-bg);
        color: var(--chats-accent-ink);
        font-size: 0.625rem;
        font-weight: 600;
      }

      .stacked.is-first {
        top: 0;
        left: 0;
      }

      .stacked.is-second {
        right: 0;
        bottom: 0;
      }
    `,
  ],
  template: `
    @if (shown().length <= 1) {
      <span class="single">
        <messenger-avatar
          [url]="shown()[0]?.url ?? ''"
          [name]="shown()[0]?.name ?? ''"
          [initialOverride]="shown()[0]?.initial ?? ''"
        />
      </span>
    } @else {
      <span class="stacked is-first">
        <messenger-avatar
          [url]="shown()[0].url"
          [name]="shown()[0].name"
          [initialOverride]="shown()[0].initial"
        />
      </span>
      <span class="stacked is-second">
        <messenger-avatar
          [url]="shown()[1].url"
          [name]="shown()[1].name"
          [initialOverride]="shown()[1].initial"
        />
      </span>
    }
  `,
})
export class AvatarStackComponent {
  readonly faces = input<readonly AvatarFace[]>([]);

  protected readonly shown = computed(() => this.faces().slice(0, 2));
}
