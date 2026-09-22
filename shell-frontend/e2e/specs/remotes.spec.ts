import { authedTest as test, expect, isRemoteUp } from "../fixtures";

/**
 * Same contract for every remote: offline → the REMOTE_UNAVAILABLE dialog
 * (never a silent failure); online → the MF module loads in shelled mode with
 * the slim sub-header (tabs, no theme/lang/profile — the shell owns those).
 * Each case self-skips when the remote is in the opposite state, so exactly
 * one of the pair runs per remote (shell-only CI exercises the offline path).
 */
const REMOTES = [
  {
    name: "chatbot",
    entry: "http://localhost:4001/remoteEntry.js",
    path: "/chatbot",
    layout: ".chatbot-layout",
    card: /chatbot/i,
  },
  {
    name: "event-store",
    entry: "http://localhost:4002/remoteEntry.js",
    path: "/event-store",
    layout: ".event-store-layout",
    card: /event store/i,
  },
  {
    name: "messenger",
    entry: "http://localhost:4003/remoteEntry.js",
    path: "/messenger",
    layout: ".messenger-layout",
    card: /messenger/i,
  },
];

for (const remote of REMOTES) {
  test(`offline ${remote.name} surfaces the App Unavailable dialog`, async ({
    page,
  }) => {
    test.skip(
      await isRemoteUp(remote.entry),
      `${remote.name} remote is running — offline dialog not reproducible`,
    );

    await page.goto("/");
    await page.getByRole("button", { name: remote.card }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("App Unavailable")).toBeVisible();

    // Footer is "OK", panel X is "Close" — distinct names, no .last() needed
    await dialog.getByRole("button", { name: /^ok$/i }).click();
    await expect(dialog).toBeHidden();
  });

  test(`running ${remote.name} loads hosted with the slim sub-header`, async ({
    page,
  }) => {
    test.skip(
      !(await isRemoteUp(remote.entry)),
      `${remote.name} remote not running — start it for hosted coverage`,
    );

    await page.goto(remote.path);
    await expect(page.locator(remote.layout)).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();

    const subHeader = page.locator("datha-sub-header");
    await expect(
      subHeader.getByRole("link", { name: "Overview" }),
    ).toBeVisible();
    await expect(subHeader.locator("datha-theme-select")).toHaveCount(0);
  });
}
