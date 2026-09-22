import { config } from "../config";

/**
 * Send-time i18n for email rendering — server-side twin of the shell service
 * worker's catalog fetch (platform/platform-notifications.md): notification
 * copy has exactly one home, shell `/assets/i18n/*.json`. Catalogs are cached
 * in memory with a TTL; on fetch failure the raw key is rendered instead.
 */

const CATALOG_TTL_MS = 10 * 60 * 1000;
const FALLBACK_LOCALE = "en";

type Catalog = Record<string, unknown>;

interface CacheEntry {
  catalog: Catalog | null;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

async function loadCatalog(locale: string): Promise<Catalog | null> {
  const cached = cache.get(locale);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS)
    return cached.catalog;

  try {
    const response = await fetch(
      `${config.SHELL_PUBLIC_URL}/assets/i18n/${locale}.json`,
    );
    if (response.ok) {
      const catalog = (await response.json()) as Catalog;
      cache.set(locale, { catalog, fetchedAt: Date.now() });
      return catalog;
    }
  } catch {
    // shell unreachable — fall through to stale cache / null
  }
  // Keep serving a stale catalog over nothing; cache the miss briefly otherwise.
  if (cached?.catalog) return cached.catalog;
  cache.set(locale, { catalog: null, fetchedAt: Date.now() });
  return null;
}

/** Resolve "A.B.C" in a nested catalog; null when missing or not a string leaf. */
function resolveKey(catalog: Catalog, key: string): string | null {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (node == null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

/** ngx-translate style interpolation: "Hello {{name}}". */
function interpolate(
  template: string,
  params: Record<string, unknown> | undefined,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = params?.[name];
    return value == null ? match : String(value);
  });
}

export async function translate(
  locale: string,
  key: string,
  params?: Record<string, unknown>,
): Promise<string> {
  for (const candidate of locale === FALLBACK_LOCALE
    ? [locale]
    : [locale, FALLBACK_LOCALE]) {
    const catalog = await loadCatalog(candidate);
    const template = catalog ? resolveKey(catalog, key) : null;
    if (template) return interpolate(template, params);
  }
  return key;
}

/** Test hook — the module-level cache would otherwise leak between tests. */
export function clearCatalogCache(): void {
  cache.clear();
}
