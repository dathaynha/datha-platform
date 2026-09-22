import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { DialogModule } from "primeng/dialog";
import { PersonAvatarComponent } from "src/modules/shared/person-avatar/person-avatar.component";
import { PersonChipsComponent } from "src/modules/shared/person-chips/person-chips.component";
import type { DirectoryUser } from "src/models/messenger.model";

/** One row of the member list. */
export interface GroupMember {
  ownerId: string;
  name: string;
  avatarUrl: string;
  /** Directory-resolved letter; never derived from `name`, which may be an id. */
  initial: string;
  admin: boolean;
  /** The viewer's own row, labelled rather than hidden. */
  self: boolean;
}

/**
 * A group's details: who is in it, its name, and the way out.
 *
 * Everything here is admin-gated **server-side** — rename and add both answer
 * 403 to a plain member. The UI hides those controls to match, but the hiding
 * is a courtesy, not the enforcement: `services/messenger-service` owns that
 * and this component must never be the only thing standing between a member
 * and an admin action.
 *
 * Leaving is offered to everyone, admins included. A group that can strand its
 * last admin is a support problem; a group nobody can leave is worse.
 */
@Component({
  selector: "messenger-group-details-dialog",
  imports: [
    TranslateModule,
    DialogModule,
    PersonAvatarComponent,
    PersonChipsComponent,
  ],
  templateUrl: "./group-details-dialog.component.html",
  styleUrls: ["./group-details-dialog.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupDetailsDialogComponent {
  readonly visible = input(false);
  readonly title = input("");
  readonly members = input<readonly GroupMember[]>([]);
  readonly admin = input(false);
  readonly results = input<readonly DirectoryUser[]>([]);
  readonly searching = input(false);
  /** True while a rename, add or leave is in flight. */
  readonly busy = input(false);

  readonly search = output<string>();
  readonly rename = output<string>();
  readonly add = output<readonly string[]>();
  readonly leave = output<void>();
  readonly close = output<void>();

  protected readonly draftTitle = signal("");
  protected readonly adding = signal(false);
  protected readonly query = signal("");
  protected readonly selected = signal<ReadonlyMap<string, DirectoryUser>>(
    new Map(),
  );
  protected readonly confirmingLeave = signal(false);

  protected readonly selectedList = computed(() => [
    ...this.selected().values(),
  ]);

  /**
   * People already in the group are filtered out of the search.
   *
   * The server tolerates re-adding an existing member — `upsertParticipants`
   * is idempotent — but offering it invites the question of what happened,
   * since nothing visibly changes.
   */
  protected readonly addable = computed(() => {
    const existing = new Set(this.members().map((member) => member.ownerId));
    return this.results().filter((person) => !existing.has(person.ownerId));
  });

  /**
   * A rename is offered only when the box holds something different and not
   * nothing: a group here is always named, so clearing the box is not a way to
   * remove the name — it is an unfinished edit.
   */
  protected readonly titleChanged = computed(() => {
    const draft = this.draftTitle().trim();
    return draft.length > 0 && draft !== this.title().trim();
  });

  constructor() {
    // The dialog is kept mounted by the page, so its own state has to be reset
    // by hand on every close — the same reason the compose dialog does it.
    effect(() => {
      if (this.visible()) {
        this.draftTitle.set(this.title());
      } else {
        this.reset();
      }
    });
  }

  protected onTitleInput(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }

  protected onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    this.search.emit(value);
  }

  protected onRename(): void {
    if (!this.titleChanged() || this.busy()) return;
    this.rename.emit(this.draftTitle());
  }

  protected startAdding(): void {
    this.adding.set(true);
  }

  protected toggle(person: DirectoryUser): void {
    this.selected.update((current) => {
      const next = new Map(current);
      if (!next.delete(person.ownerId)) next.set(person.ownerId, person);
      return next;
    });
  }

  protected isSelected(ownerId: string): boolean {
    return this.selected().has(ownerId);
  }

  protected onAdd(): void {
    if (this.selected().size === 0 || this.busy()) return;
    this.add.emit([...this.selected().keys()]);
    this.adding.set(false);
    this.query.set("");
    this.selected.set(new Map());
  }

  /**
   * Leaving cannot be undone from here — rejoining needs an admin — so it is
   * confirmed. The confirmation is inline, with a named action and a Cancel,
   * rather than a second press of the same button: a button that means
   * something different the second time is a trap, and a modal over a modal is
   * the other thing to avoid.
   */
  protected askLeave(): void {
    this.confirmingLeave.set(true);
  }

  protected cancelLeave(): void {
    this.confirmingLeave.set(false);
  }

  protected confirmLeave(): void {
    if (this.busy()) return;
    this.leave.emit();
  }

  private reset(): void {
    this.adding.set(false);
    this.query.set("");
    this.selected.set(new Map());
    this.confirmingLeave.set(false);
  }
}
