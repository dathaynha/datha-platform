/*
 * Public API Surface of platform-ui
 */

export { platformAuraPreset } from "./lib/theme/platform-aura-preset";
export {
  DATHA_THEME_ICONS,
  DATHA_THEME_IDS,
  isDathaThemeId,
  normalizeDathaThemeId,
  type DathaThemeId,
} from "./lib/theme/datha-theme.model";
export {
  type ConfirmDialogModel,
  type HelpDialogData,
  type MessageDialogData,
} from "./lib/dialogs/dialog.models";
export { MessageDialogComponent } from "./lib/dialogs/message-dialog.component";
export { ConfirmationDialogComponent } from "./lib/dialogs/confirmation-dialog.component";
export { HelpDialogComponent } from "./lib/dialogs/help-dialog.component";
export {
  LoginCardComponent,
  type DathaEntraPool,
  type DathaLoginProvider,
} from "./lib/login/login-card.component";
export {
  DATHA_SHELL_CONTEXT,
  type DathaOwnerProfile,
  type DathaShellContext,
} from "./lib/context/datha-shell-context";
export {
  registerRemoteTranslations,
  type DathaTranslationBundles,
  type DathaTranslationTree,
} from "./lib/i18n/register-remote-translations";
export { ThemeSelectComponent } from "./lib/controls/theme-select.component";
export {
  DATHA_LANGUAGE_LABELS,
  LangSelectComponent,
} from "./lib/controls/lang-select.component";
export { BrandMarkComponent } from "./lib/brand/brand-mark.component";
export { SubHeaderComponent } from "./lib/chrome/sub-header.component";
export type { DathaSubHeaderTab } from "./lib/chrome/sub-header.component";
export { ProfilePopoverComponent } from "./lib/profile/profile-popover.component";
export type { DathaProfileMenuItem } from "./lib/profile/profile-popover.component";
