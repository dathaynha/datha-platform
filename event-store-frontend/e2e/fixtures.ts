import { test as base } from "@playwright/test";
import { STORAGE_STATE_PATH } from "./global-setup";

/** Authenticated test: browser context pre-seeded by global-setup. */
export const authedTest = base.extend({
  storageState: STORAGE_STATE_PATH,
});

export { expect } from "@playwright/test";
