import { TranslateService, TranslateStore } from "@ngx-translate/core";

export type DathaTranslationTree = Record<string, unknown>;

/** Language code → translation catalog (the remote's imported JSON bundles). */
export type DathaTranslationBundles = Record<string, DathaTranslationTree>;

function cloneTree<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isTree(value: unknown): value is DathaTranslationTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `over` wins leaf by leaf; anything only `base` has survives.
 *
 * Both sides are already clones, so this mutates `base` and returns it.
 */
function mergeTree(
  base: DathaTranslationTree,
  over: DathaTranslationTree,
): DathaTranslationTree {
  for (const key of Object.keys(over)) {
    const incoming = over[key];
    const existing = base[key];
    base[key] =
      isTree(existing) && isTree(incoming)
        ? mergeTree(existing, incoming)
        : incoming;
  }
  return base;
}

/**
 * The host's own catalog, per store, captured before any remote touches it.
 *
 * Keyed on the `TranslateStore` rather than held as module state so that each
 * Angular injector — every `TestBed`, and a standalone remote as much as the
 * shell — gets its own baseline, and so it is collected with the store.
 */
const hostBaseline = new WeakMap<
  TranslateStore,
  Map<string, DathaTranslationTree>
>();

function baselineFor(
  store: TranslateStore,
  lang: string,
): DathaTranslationTree {
  let perLang = hostBaseline.get(store);
  if (!perLang) {
    perLang = new Map<string, DathaTranslationTree>();
    hostBaseline.set(store, perLang);
  }
  if (!perLang.has(lang)) {
    perLang.set(
      lang,
      cloneTree((store.getTranslations(lang) ?? {}) as DathaTranslationTree),
    );
  }
  return perLang.get(lang) as DathaTranslationTree;
}

/**
 * Register a remote's catalogs on the shared shell TranslateService.
 *
 * Each top-level namespace in the bundle is rebuilt as **the host's baseline
 * for that namespace, with the remote's leaves merged over it** — not as a
 * plain replacement and not as a merge onto whatever is currently there.
 * Those three differ, and each of the other two has shipped a bug:
 *
 * - **Replacing the whole subtree** (until 2026-09-20) drops any leaf only the
 *   host has. The shell's profile menu is built from `PROFILE.*` and the shell
 *   alone defines `PROFILE.SUPPORT`, so mounting any remote — every one of
 *   which must ship a `PROFILE` block, because this library hardcodes those
 *   keys for standalone use — rendered the raw key `PROFILE.SUPPORT` in the
 *   popup. Reported with a screenshot.
 * - **Merging onto the current tree** leaves one remote's keys behind when
 *   another mounts: two remotes both using `LANDING.*` would see the other's
 *   stale leaves. Starting from the baseline instead of from "now" is what
 *   keeps that fixed.
 *
 * Namespaces this bundle does not mention are left exactly as they are, so a
 * remote whose header widget stays mounted across routes keeps its strings.
 *
 * Call from remote-entry (first load) and shelled authenticated-layout (every
 * time the user navigates back to that remote).
 */
export function registerRemoteTranslations(
  translate: TranslateService,
  store: TranslateStore,
  bundles: DathaTranslationBundles,
): void {
  for (const lang of Object.keys(bundles)) {
    const bundle = bundles[lang];
    const baseline = baselineFor(store, lang);
    const merged: DathaTranslationTree = {
      ...store.getTranslations(lang),
    };
    for (const key of Object.keys(bundle)) {
      const hostSubtree = baseline[key];
      const incoming = cloneTree(bundle[key]);
      merged[key] =
        isTree(hostSubtree) && isTree(incoming)
          ? mergeTree(cloneTree(hostSubtree), incoming)
          : incoming;
    }
    translate.setTranslation(
      lang,
      merged as Parameters<TranslateService["setTranslation"]>[1],
      false,
    );
  }

  const active = translate.currentLang || translate.defaultLang || "en";
  if (translate.currentLang) {
    translate.use(active);
  }
}
