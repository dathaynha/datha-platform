import type { DathaTranslationBundles } from "@datha/platform-ui";
import deTranslations from "src/assets/i18n/de.json";
import enTranslations from "src/assets/i18n/en.json";

/** This remote's catalogs, passed to the lib's registerRemoteTranslations. */
export const REMOTE_TRANSLATION_BUNDLES: DathaTranslationBundles = {
  en: enTranslations,
  de: deTranslations,
};
