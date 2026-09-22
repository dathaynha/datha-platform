import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the shell dev server (:4000). Auth is seeded, not clicked
 * through: global-setup mints a gateway-shaped HS256 JWT and writes a
 * storageState with the angular-oauth2-oidc localStorage keys — no OAuth
 * provider round-trip, works headless and in CI (see e2e/global-setup.ts).
 */
export default defineConfig({
  testDir: "./e2e/specs",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  // Local runs share the machine with the platform's dev servers and Docker infra.
  // Two Chrome instances starve *browser launch* there: tests fail with "timeout
  // exceeded while setting up context" before a line of test code runs, which reads
  // like a flaky spec but is not one. CI agents are dedicated, so they stay parallel.
  workers: process.env["CI"] ? undefined : 1,
  // Same reason: a starved launch can blow the 30s default while setting up the
  // context, long before any assertion runs.
  timeout: process.env["CI"] ? 30_000 : 60_000,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"]
    ? [["list"], ["junit", { outputFile: "test-results/e2e-junit.xml" }]]
    : "list",
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://localhost:4000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // System Chrome: no browser download locally; ADO hosted agents ship it too.
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: "pnpm start",
    url: "http://localhost:4000",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
