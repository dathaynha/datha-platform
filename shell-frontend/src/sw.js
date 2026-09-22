/**
 * Shell service worker — Web Push only (no offline caching; MF chunks stay network-served).
 *
 * Push payloads carry i18n KEYS + params + the owner's locale, never rendered
 * strings — the worker fetches the shell's own translation catalog and renders
 * here, so the single source of truth for notification copy stays in
 * /assets/i18n/*.json (platform/platform-notifications.mdc).
 */

const I18N_CACHE = "datha-i18n-v1";
const FALLBACK_LOCALE = "en";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Network-first with cache fallback — catalog stays fresh but survives offline. */
async function loadCatalog(locale) {
  const url = `/assets/i18n/${locale}.json`;
  const cache = await caches.open(I18N_CACHE);
  try {
    const response = await fetch(url);
    if (response.ok) {
      await cache.put(url, response.clone());
      return await response.json();
    }
  } catch {
    // offline — fall through to cache
  }
  const cached = await cache.match(url);
  return cached ? cached.json() : null;
}

/** Resolve "A.B.C" in a nested catalog; returns null when missing or key is not a string. */
function resolveKey(catalog, key) {
  if (typeof key !== "string" || !key) return null;
  let node = catalog;
  for (const part of key.split(".")) {
    if (node == null || typeof node !== "object") return null;
    node = node[part];
  }
  return typeof node === "string" ? node : null;
}

/** ngx-translate style interpolation: "Hello {{name}}". */
function interpolate(template, params) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name) => {
    const value = params?.[name];
    return value == null ? match : String(value);
  });
}

async function translate(locale, key, params) {
  for (const candidate of [locale, FALLBACK_LOCALE]) {
    const catalog = await loadCatalog(candidate);
    const template = catalog ? resolveKey(catalog, key) : null;
    if (template) return interpolate(template, params);
  }
  // last resort: show the key rather than nothing (and never a non-string)
  return typeof key === "string" ? key : "";
}

self.addEventListener("push", (event) => {
  if (!event.data) return;
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data.json();
      } catch {
        return;
      }

      // A focused shell tab already shows the SSE toast — skip the OS notification.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.some((w) => w.focused)) return;

      const locale = payload.locale || FALLBACK_LOCALE;
      const title = await translate(locale, payload.titleKey, payload.params);
      const body = await translate(locale, payload.bodyKey, payload.params);

      await self.registration.showNotification(title, {
        body,
        tag: payload.id, // same notification never stacks twice
        icon: "/favicon.ico",
        data: { link: payload.link || "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification.data?.link || "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows[0];
      if (existing) {
        await existing.focus();
        // SPA navigation via the client if possible, else hard navigate.
        existing.navigate ? await existing.navigate(link) : null;
        return;
      }
      await self.clients.openWindow(link);
    })(),
  );
});
