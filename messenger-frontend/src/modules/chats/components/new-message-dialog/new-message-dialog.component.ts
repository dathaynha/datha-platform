import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { DialogModule } from "primeng/dialog";
import { PersonAvatarComponent } from "src/modules/shared/person-avatar/person-avatar.component";
import { PersonChipsComponent } from "src/modules/shared/person-chips/person-chips.component";
import type { DirectoryUser } from "src/models/messenger.model";

/**
 * A group needs a name and at least one other person.
 *
 * dathq's call, 2026-09-14, after trying both: the WhatsApp / Telegram / Signal
 * model, where a group is a first-class object with an identity of its own.
 * Because it always carries a name, it can hold a single other member without
 * being confusable with the direct chat with that person.
 *
 * The two rules are one decision, not two. The other camp — Messenger, Slack,
 * Teams — leaves the name optional and derives it from the members, which only
 * works with a **two**-other minimum so the derived title always carries two
 * names. Take the required name and you may allow one other; take the optional
 * name and you may not. Mixing them shipped a group indistinguishable from a
 * DM earlier the same day.
 */
const MIN_GROUP_MEMBERS = 1;

export interface GroupRequest {
  ownerIds: readonly string[];
  title: string;
}

/**
 * Directory search, and the only place in the product that talks to
 * accounts-service. The sidebar's own search filters loaded conversations
 * instead — one box per data source, so neither has to explain itself.
 *
 * This component is **not** destroyed when the dialog closes — the page keeps
 * it mounted and only toggles `visible` — so its query has to be cleared by
 * hand. Without that, reopening showed the previous search still typed in
 * (reported 2026-09-09).
 *
 * The reset watches the `visible` **input** rather than p-dialog's `onHide`:
 * that event did not fire when the parent lowered `visible` itself, which is
 * how every close here works, so the box stayed dirty. Watching the input is
 * also independent of PrimeNG's animation and event semantics. Focus still
 * uses `onShow`, because the dialog renders its content lazily and there is no
 * element to focus any earlier.
 *
 * **Two modes, one dialog.** Picking a single person stays a single click and
 * writes nothing — the conversation is still created by the first message. A
 * group cannot work that way (it has no identity until it exists), so it is a
 * deliberate mode with a confirm step rather than a side effect of selecting
 * two people. WhatsApp and Signal both make the same split.
 */
@Component({
  selector: "messenger-new-message-dialog",
  imports: [
    TranslateModule,
    DialogModule,
    PersonAvatarComponent,
    PersonChipsComponent,
  ],
  templateUrl: "./new-message-dialog.component.html",
  styleUrls: ["./new-message-dialog.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NewMessageDialogComponent {
  readonly visible = input(false);
  readonly results = input<readonly DirectoryUser[]>([]);
  readonly searching = input(false);
  /** True while the group POST is in flight; the confirm button waits on it. */
  readonly creating = input(false);

  readonly search = output<string>();
  readonly pick = output<string>();
  readonly createGroup = output<GroupRequest>();
  readonly close = output<void>();

  protected readonly query = signal("");
  protected readonly grouping = signal(false);
  protected readonly title = signal("");
  /** Selected people, keyed by owner id so a chip can render without a lookup. */
  protected readonly selected = signal<ReadonlyMap<string, DirectoryUser>>(
    new Map(),
  );

  protected readonly selectedList = computed(() => [
    ...this.selected().values(),
  ]);
  /** A group is named before it exists; the server would accept a null title. */
  protected readonly canCreate = computed(
    () =>
      this.selected().size >= MIN_GROUP_MEMBERS &&
      this.title().trim().length > 0 &&
      !this.creating(),
  );

  private readonly searchInput =
    viewChild<ElementRef<HTMLInputElement>>("searchInput");

  constructor() {
    effect(() => {
      if (!this.visible()) this.reset();
    });
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    this.search.emit(value);
  }

  protected onTitle(event: Event): void {
    this.title.set((event.target as HTMLInputElement).value);
  }

  /** A search dialog with an unfocused box costs the user a click every time. */
  protected onShow(): void {
    this.searchInput()?.nativeElement.focus();
  }

  protected startGroup(): void {
    this.grouping.set(true);
  }

  protected isSelected(ownerId: string): boolean {
    return this.selected().has(ownerId);
  }

  /**
   * A row does one of two things depending on the mode, and never both: in
   * group mode picking someone must not also open a direct thread under the
   * dialog.
   */
  protected onPickPerson(person: DirectoryUser): void {
    if (!this.grouping()) {
      this.pick.emit(person.ownerId);
      return;
    }
    this.toggle(person);
  }

  protected toggle(person: DirectoryUser): void {
    this.selected.update((current) => {
      const next = new Map(current);
      if (!next.delete(person.ownerId)) next.set(person.ownerId, person);
      return next;
    });
  }

  protected onCreate(): void {
    if (!this.canCreate()) return;
    this.createGroup.emit({
      ownerIds: [...this.selected().keys()],
      title: this.title(),
    });
  }

  private reset(): void {
    this.query.set("");
    this.title.set("");
    this.grouping.set(false);
    this.selected.set(new Map());
  }
}
