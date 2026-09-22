import { authedTest as test, expect } from "../fixtures";
import { mockBackend } from "../mock-backend";

/**
 * Connector labels: prose is styled, literals are quoted.
 *
 * `.flow-link` applies `text-transform: uppercase`, which is the right
 * treatment for a short label and the wrong one for an identifier — changing
 * the case of an identifier changes what it says. Spotted 2026-09-21 as
 * `createOffer` rendering `CREATEOFFER`; the same rule had been quietly
 * mangling two others for as long as the page existed, `rt.owner.<id>` into a
 * NATS subject that does not exist and `POST /api/messenger` into a path that
 * does not either. Uppercase hid both inside a style.
 *
 * `innerText` rather than `textContent`, deliberately: `textContent` returns
 * the DOM string and is identical either way, so it would pass against the
 * bug. Only the rendered text can see a `text-transform`.
 */

const CODE_LABELS = ["POST /api/messenger", "rt.owner.<id>", "createOffer"];

const renderedLinks = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".flow-link")).map((el) => {
      const label = el.querySelector("span:last-child") as HTMLElement;
      return {
        source: (label.textContent ?? "").trim(),
        rendered: label.innerText.trim(),
        mono: getComputedStyle(el).fontFamily.includes("mono"),
      };
    }),
  );

test("a literal renders verbatim; prose takes the uppercase treatment", async ({
  page,
}) => {
  await mockBackend(page);
  await page.goto("/");
  await page.locator(".flow-link").first().waitFor();

  const seen: string[] = [];
  // Anchored on the label that must appear, not on the links being visible:
  // the outgoing flow's links are visible too, so `toBeVisible()` passed
  // instantly and both passes read the message flow.
  for (const [tab, firstLabel] of [
    [0, "POST /api/messenger"],
    [1, "createOffer"],
  ] as const) {
    await page.locator(".flow-picker__tab").nth(tab).click();
    await expect
      .poll(async () => (await renderedLinks(page))[0]?.source)
      .toBe(firstLabel);

    for (const link of await renderedLinks(page)) {
      seen.push(link.source);
      if (CODE_LABELS.includes(link.source)) {
        expect(link.rendered, `${link.source} must not be transformed`).toBe(
          link.source,
        );
        expect(link.mono, `${link.source} should read as a literal`).toBe(true);
      } else {
        // The styling still applies everywhere it belongs.
        expect(
          link.rendered,
          `${link.source} should take the label treatment`,
        ).toBe(link.source.toUpperCase());
        expect(link.mono).toBe(false);
      }
    }
  }

  // Every literal was actually on screen — otherwise the loop above proves
  // nothing about the ones that matter.
  for (const label of CODE_LABELS) {
    expect(seen, `${label} should be rendered by one of the flows`).toContain(
      label,
    );
  }
});
