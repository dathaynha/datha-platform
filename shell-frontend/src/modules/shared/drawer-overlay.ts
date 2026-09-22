/**
 * Sweeps PrimeNG drawer masks that a navigation left behind.
 *
 * Closing a drawer while navigating orphans its overlay mask: PrimeNG removes
 * it via `renderer.removeChild` on the mask's `animationend`, and with a route
 * change in between the removal silently no-ops (verified against PrimeNG
 * 21.2.8). The leftover is a full-screen element that swallows every click.
 *
 * Several sweeps rather than one, because a cold lazy route delays the leave
 * animation — the orphan can appear well after the first pass. `stillOpen`
 * guards against removing the mask of a drawer the user has reopened in the
 * meantime.
 */
export function sweepOrphanedDrawerMasks(stillOpen: () => boolean): void {
  for (const delay of [400, 1000, 2000]) {
    setTimeout(() => {
      if (stillOpen()) return;
      document
        .querySelectorAll(".p-drawer-mask.p-overlay-mask")
        .forEach((mask) => mask.remove());
    }, delay);
  }
}
