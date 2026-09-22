import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { TranslateModule } from "@ngx-translate/core";
import type { CallMedia } from "src/models/call.model";
import type { Conversation } from "src/models/messenger.model";
import {
  AvatarStackComponent,
  type AvatarFace,
} from "src/modules/shared/avatar-stack/avatar-stack.component";

export interface ConversationRow {
  conversation: Conversation;
  title: string;
  preview: string;
  /**
   * The counterpart's presence, or null for a group.
   *
   * A group has no single presence to show, and a dot fed by "the first other
   * participant" would claim something about whoever happened to be listed
   * first. Null renders no dot at all.
   */
  presence: "online" | "away" | "offline" | null;
  /**
   * The kind of call happening here right now, or null when none is.
   *
   * The *kind*, not a flag, so the row can show the glyph the thread shows for
   * the same call — a handset for audio, a camera for video. Derived from the
   * row's own `lastCall` having no end, so it needs nothing from the server
   * that the list did not already carry, and it stays honest for a call whose
   * closer died because messenger-service applies the lifetime bound on read.
   */
  ongoingCall: CallMedia | null;
  unread: boolean;
  /** One face for a direct thread, the members' faces for a group. */
  faces: readonly AvatarFace[];
}

/**
 * The sidebar list. Search filters the rows already loaded — no endpoint, no
 * debounce, no race; the directory search lives in the new-message dialog,
 * where there is room for a second data source.
 */
@Component({
  selector: "messenger-conversation-list",
  imports: [TranslateModule, DatePipe, AvatarStackComponent],
  templateUrl: "./conversation-list.component.html",
  styleUrls: ["./conversation-list.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConversationListComponent {
  readonly rows = input.required<readonly ConversationRow[]>();
  readonly activeId = input<string | null>(null);
  readonly loading = input(false);
  /** Set when the list could not be loaded — shown inline, never as a modal. */
  readonly failed = input(false);

  readonly select = output<string>();
  readonly compose = output<void>();
  /** Open this conversation in a docked mini window instead of the stage. */
  readonly dock = output<string>();

  protected readonly query = signal("");

  protected readonly filtered = computed(() => {
    const needle = this.query().trim().toLowerCase();
    if (!needle) return this.rows();
    return this.rows().filter(
      (row) =>
        row.title.toLowerCase().includes(needle) ||
        row.preview.toLowerCase().includes(needle),
    );
  });

  protected onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
