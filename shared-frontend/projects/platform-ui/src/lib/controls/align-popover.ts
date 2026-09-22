/** The minimum a panel keeps from the viewport edge when it is pulled back. */
const VIEWPORT_MARGIN = 8;

interface PopoverLike {
  container?: HTMLElement | null;
  hide: () => void;
}

/**
 * Centres a menu panel on the control that opened it, inside the viewport.
 *
 * PrimeNG positions a popover's **left** edge on its trigger and only flips
 * when the panel would leave the viewport. For a 40px chip that hangs a 186px
 * panel out to the right across its neighbours; right-aligning it instead put
 * the whole panel to the *left* of the chip, which reads just as detached.
 * Centred is what a menu hung off a small button should be, and it is what
 * makes the chip look like the thing the menu belongs to.
 *
 * Then it is clamped: on a narrow screen a centred panel would run off one
 * edge or the other, so it is pulled back to `VIEWPORT_MARGIN` and, if the
 * panel is simply wider than the screen allows, pinned to the left margin —
 * `max-width` in the stylesheet keeps it from being wider than that.
 *
 * Reads `offsetWidth`, not a bounding rect: `onShow` fires while the panel is
 * still scaling in, and a rect taken mid-animation is measurably off its
 * resting position.
 */
export function alignPopoverToTrigger(
  popover: PopoverLike,
  anchor: HTMLElement,
): void {
  const panel = popover.container;
  if (!panel) return;

  const trigger = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  if (width === 0) return;

  const centre = trigger.left + window.scrollX + trigger.width / 2;
  const rightLimit = window.scrollX + document.documentElement.clientWidth;
  const furthestLeft = rightLimit - width - VIEWPORT_MARGIN;
  const left = Math.max(
    window.scrollX + VIEWPORT_MARGIN,
    Math.min(centre - width / 2, furthestLeft),
  );
  panel.style.left = `${left}px`;
}

/**
 * Closes a menu on any press outside it, in the **capture** phase.
 *
 * PrimeNG already dismisses on an outside click, and it is not enough: opening
 * the messenger header widget left a theme or language menu on screen beside
 * it (dathq, 2026-09-17). That widget re-dispatches its trigger's click after
 * the original dispatch has finished — its own code says so — so by the time
 * PrimeNG's document handler runs, the event target is no longer where it was
 * and the outside-click test does not fire.
 *
 * Capture-phase `mousedown` runs before any of that and does not depend on the
 * target still being attached, so one menu at a time holds however a rival
 * overlay chooses to open. Returns a teardown for the caller's `DestroyRef`.
 */
export function dismissOnOutsidePress(
  popover: PopoverLike,
  isInside: (target: Node) => boolean,
): () => void {
  const onPress = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Node) || isInside(target)) return;
    popover.hide();
  };

  document.addEventListener("mousedown", onPress, true);
  return () => document.removeEventListener("mousedown", onPress, true);
}
