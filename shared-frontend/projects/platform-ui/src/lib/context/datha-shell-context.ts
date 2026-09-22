import { InjectionToken } from "@angular/core";
import { Observable } from "rxjs";
import type { DathaThemeId } from "../theme/datha-theme.model";

export interface DathaOwnerProfile {
  name: string;
  email: string;
  username?: string;
}

/**
 * Contract passed from the shell to every hosted Angular remote.
 *
 * Angular remotes inject this token at bootstrap:
 *   - present → hosted mode (skip own OAuth, hide outer controls)
 *   - absent  → standalone mode (run own OAuth, show full UI)
 *
 * Remotes must never mutate shell state directly; use the provided callbacks.
 */
export interface DathaShellContext {
  authToken$: Observable<string | null>;
  lang$: Observable<string>;
  theme$: Observable<DathaThemeId>;
  ownerProfile$: Observable<DathaOwnerProfile | null>;
  logout: () => void;
  setLang: (lang: string) => void;
  setTheme: (theme: DathaThemeId) => void;
}

export const DATHA_SHELL_CONTEXT = new InjectionToken<DathaShellContext>(
  "DATHA_SHELL_CONTEXT",
);
