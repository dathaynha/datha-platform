import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCatalogCache, translate } from "./shell-catalog";

vi.mock("../config", () => ({
  config: { SHELL_PUBLIC_URL: "http://localhost:4000" },
}));

const CATALOGS: Record<string, unknown> = {
  en: { NOTIFICATIONS: { FILE_CLEANUP: { TITLE: "Attachment cleaned up" } } },
  de: {
    NOTIFICATIONS: {
      FILE_CLEANUP: { TITLE: "Anhang bereinigt ({{file_id}})" },
    },
  },
};

function mockFetch(impl?: (url: string) => Promise<Response>) {
  const fn = vi.fn(
    impl ??
      (async (url: string) => {
        const locale = url.match(/i18n\/(\w+)\.json/)?.[1] ?? "";
        const catalog = CATALOGS[locale];
        return catalog
          ? new Response(JSON.stringify(catalog), { status: 200 })
          : new Response("", { status: 404 });
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("shell-catalog translate", () => {
  beforeEach(() => clearCatalogCache());
  afterEach(() => vi.unstubAllGlobals());

  it("renders the key from the fetched catalog with param interpolation", async () => {
    mockFetch();
    const result = await translate("de", "NOTIFICATIONS.FILE_CLEANUP.TITLE", {
      file_id: "f1",
    });
    expect(result).toBe("Anhang bereinigt (f1)");
  });

  it("caches the catalog — one fetch for repeated translates", async () => {
    const fetchFn = mockFetch();
    await translate("en", "NOTIFICATIONS.FILE_CLEANUP.TITLE");
    await translate("en", "NOTIFICATIONS.FILE_CLEANUP.TITLE");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("falls back to the en catalog when the locale catalog is missing", async () => {
    mockFetch();
    const result = await translate("fr", "NOTIFICATIONS.FILE_CLEANUP.TITLE");
    expect(result).toBe("Attachment cleaned up");
  });

  it("returns the raw key when the shell is unreachable", async () => {
    mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await translate("en", "NOTIFICATIONS.FILE_CLEANUP.TITLE");
    expect(result).toBe("NOTIFICATIONS.FILE_CLEANUP.TITLE");
  });

  it("returns the raw key when the resolved node is not a string leaf", async () => {
    mockFetch();
    const result = await translate("en", "NOTIFICATIONS.FILE_CLEANUP");
    expect(result).toBe("NOTIFICATIONS.FILE_CLEANUP");
  });
});
