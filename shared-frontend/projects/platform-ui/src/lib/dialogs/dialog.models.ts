export interface HelpDialogData {
  message: string;
}

export interface ConfirmDialogModel {
  title?: string;
  message: string;
}

export interface MessageDialogData {
  /** i18n key for the dialog body (e.g. "CONNECTION_LOST.message"). Preferred over `message`. */
  messageKey?: string;
  /** Pre-translated or server-provided HTML body. Used when `messageKey` is absent. */
  message?: string;
  /** i18n key for the dialog title bar (e.g. "CONNECTION_LOST.title"). */
  titleKey?: string;
}
