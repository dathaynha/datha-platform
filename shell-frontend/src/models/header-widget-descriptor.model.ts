/**
 * A remote-owned widget rendered in the shell header.
 *
 * Ambient products (a live socket, a badge, ringing) belong here rather than in
 * `environment.apps`: the launcher is for destinations you navigate to, while a
 * header widget must stay mounted on every page. Onboarding one is a single
 * `environment.headerWidgets` entry — the shell never imports product code.
 *
 * The exposed module must export the standalone component as its **default**
 * export, so the shell needs no per-product class name.
 */
export interface HeaderWidgetDescriptor {
  /** Module Federation remote name; must exist in `environment.remotes`. */
  remoteName: string;
  /** Exposed module path, e.g. "./HeaderWidget". */
  exposedModule: string;
  /** Ascending placement between the language select and the bell. */
  order: number;
}
