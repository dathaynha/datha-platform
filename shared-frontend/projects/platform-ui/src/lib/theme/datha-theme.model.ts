/**
 * Platform themes: **Starlight** (light) and **Midnight** (dark).
 * Apps persist the id (conventionally under localStorage key `theme`) and
 * toggle `.dark` on `document.documentElement` for the Aura dark selector.
 */
export const DATHA_THEME_IDS = ["starlight", "midnight"] as const;

export type DathaThemeId = (typeof DATHA_THEME_IDS)[number];

/** PrimeIcons class for theme pickers (label comes from app i18n). */
export const DATHA_THEME_ICONS: Record<DathaThemeId, string> = {
  starlight: "pi pi-sun",
  midnight: "pi pi-moon",
};

export function isDathaThemeId(value: string): value is DathaThemeId {
  return (DATHA_THEME_IDS as readonly string[]).includes(value);
}

/** Maps legacy or unknown stored values to a valid theme id. */
export function normalizeDathaThemeId(raw: string | null): DathaThemeId {
  if (raw === "midnight" || raw === "dark") return "midnight";
  if (raw === "aurora") return "midnight";
  if (raw === "starlight" || raw === "light") return "starlight";
  return "starlight";
}
