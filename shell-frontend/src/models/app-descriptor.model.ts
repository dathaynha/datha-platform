/**
 * A federated product tile. `environment.apps` carries routing config only —
 * display strings come from the i18n catalog so they translate like the rest
 * of the chrome (see APPS.* keys).
 */
export interface AppDescriptor {
  /** PrimeIcons class without the `pi` prefix (e.g. "pi-comments"). */
  icon: string;
  /** Shell route the tile navigates to. */
  route: string;
  /** Module Federation remote name; also the i18n key segment. */
  remoteName: string;
}

/** `chatbot` → `APPS.CHATBOT`, `event-store` → `APPS.EVENT_STORE`. */
function appKeyBase(app: AppDescriptor): string {
  return `APPS.${app.remoteName.toUpperCase().replace(/-/g, "_")}`;
}

export function appNameKey(app: AppDescriptor): string {
  return `${appKeyBase(app)}.NAME`;
}

export function appDescriptionKey(app: AppDescriptor): string {
  return `${appKeyBase(app)}.DESCRIPTION`;
}
