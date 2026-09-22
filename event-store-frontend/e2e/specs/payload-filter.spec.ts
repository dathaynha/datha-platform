import { EVENT_FIXTURES, mockEventStoreApi } from "../event-store-api-mock";
import { authedTest as test, expect } from "../fixtures";

/**
 * The payload filter's control, measured rather than looked at.
 *
 * Every defect below was reported by dathq within minutes of first using it
 * (2026-09-20) and every one passed the functional specs, because those drive
 * the control by role and never ask what it looks like or how big it is.
 */
const openAdvanced = async (page: import("@playwright/test").Page) => {
  await mockEventStoreApi(page);
  await page.goto("/events");
  await expect(page.locator("tbody tr")).toHaveCount(EVENT_FIXTURES.length);
  await page.getByRole("button", { name: "More filters" }).click();
  await expect(page.locator("#events-filter-payload-key")).toBeVisible();
};

test.describe("payload filter control", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  /**
   * Both halves of this control are created by PrimeNG, so they carry no
   * `_ngcontent` attribute and an encapsulated rule cannot reach them. The
   * sizing fix in `ops-table()` therefore applied to the inputs written in the
   * template and silently missed these: the value box sat at 25.3px beside a
   * 38px neighbour, and the select's label kept the 11px dense tokens inside a
   * 38px box, which is what "not centered" was.
   */
  test("matches its neighbours in size, with the placeholder centred", async ({
    page,
  }) => {
    await openAdvanced(page);

    const metrics = await page.evaluate(() => {
      const host = document.querySelector(
        "p-select.events-payload-filter__key",
      ) as HTMLElement;
      const label = host.querySelector(".p-select-label") as HTMLElement;
      const value = document.querySelector(
        "#events-filter-payload-value",
      ) as HTMLElement;
      // The entity id box, because the type filter next to it became a menu
      // of its own — the comparison has to be against an actual `.datha-input`,
      // which is the thing this control is meant to match.
      const neighbour = document.querySelector(
        "#events-filter-entity",
      ) as HTMLElement;
      const hb = host.getBoundingClientRect();
      const lb = label.getBoundingClientRect();
      return {
        selectHeight: hb.height,
        valueHeight: value.getBoundingClientRect().height,
        neighbourHeight: neighbour.getBoundingClientRect().height,
        labelFontSize: getComputedStyle(label).fontSize,
        centreOffset: Math.abs(
          lb.top + lb.height / 2 - (hb.top + hb.height / 2),
        ),
      };
    });

    expect(metrics.selectHeight).toBe(metrics.neighbourHeight);
    expect(metrics.valueHeight).toBe(metrics.neighbourHeight);
    expect(metrics.labelFontSize).toBe("14px");
    // Centred, not merely inside: the old label sat at the top of the box.
    expect(metrics.centreOffset).toBeLessThanOrEqual(1);
  });

  /** `filterBy="."` named a field a string option does not have, so every
   *  search returned "No results found" while the key was plainly in the list. */
  test("filters the field menu", async ({ page }) => {
    await openAdvanced(page);

    await page.locator("#events-filter-payload-key").click();
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.locator(".p-select-overlay input").first().fill("mime");

    await expect(page.getByRole("option")).toHaveText(["mime_type"]);
  });

  /**
   * No field chosen, nothing to clear, so no clear button.
   *
   * `showClear` renders whenever the model is not null, and this signal's
   * empty state is `""` — which is not null. So a fresh load showed an X
   * beside "Select a field…" that did nothing when pressed, which is its own
   * half of "the X does not work" (dathq, 2026-09-20, with a screenshot).
   * Asserted as a **count**, because the thing that was wrong was its
   * existence, not its appearance.
   */
  test("shows a clear button only when a field is chosen", async ({ page }) => {
    await openAdvanced(page);

    const clear = page.locator("p-select.events-payload-filter__key > svg");
    const label = page.locator(
      "p-select.events-payload-filter__key .p-select-label",
    );

    await expect(label).toHaveText("Select a field…");
    await expect(clear).toHaveCount(0);

    await page.locator("#events-filter-payload-key").click();
    await page.getByRole("option", { name: "origin", exact: true }).click();
    await expect(clear).toHaveCount(1);

    await clear.click();
    await expect(clear).toHaveCount(0);
    await expect(label).toHaveText("Select a field…");
  });

  /**
   * PrimeNG draws the clear icon as a bare 16px `<svg>`, and everything the
   * icon does not cover belongs to the select — so a near-miss opens the menu
   * instead of clearing. That is what "the X needs two clicks" was.
   *
   * Reported twice. The first fix padded the target to 28x28 and cured the
   * horizontal miss only, leaving a 5px band above and below where a click
   * still hit the select — and this spec passed, because it aimed at the
   * centre. **A hit-target spec has to probe the edges of both axes**, which
   * is the only reason the second report was reproducible at all.
   */
  test("clears in one click from every corner of its target", async ({
    page,
  }) => {
    await openAdvanced(page);

    const clear = page.locator("p-select.events-payload-filter__key > svg");
    const host = page.locator("p-select.events-payload-filter__key");
    const label = host.locator(".p-select-label");

    const iconBox = await (async () => {
      await page.locator("#events-filter-payload-key").click();
      await page.getByRole("option", { name: "origin", exact: true }).click();
      await expect(label).toHaveText("origin");
      return (await clear.boundingBox())!;
    })();
    const hostBox = (await host.boundingBox())!;

    // Wide enough to aim at, and tall enough that there is no band left where
    // a click lands on the select instead.
    expect(iconBox.width).toBeGreaterThanOrEqual(24);
    expect(iconBox.height).toBeGreaterThanOrEqual(hostBox.height - 2);

    // Both axes, at the extremes rather than the middle.
    const offsets: { dx: number; dy: number }[] = [
      { dx: 0, dy: 0 },
      { dx: -iconBox.width / 2 + 3, dy: 0 },
      { dx: iconBox.width / 2 - 3, dy: 0 },
      { dx: 0, dy: -iconBox.height / 2 + 2 },
      { dx: 0, dy: iconBox.height / 2 - 2 },
    ];

    for (const { dx, dy } of offsets) {
      if (dx !== 0 || dy !== 0) {
        await page.locator("#events-filter-payload-key").click();
        await page.getByRole("option", { name: "origin", exact: true }).click();
        await expect(label).toHaveText("origin");
      }
      const box = (await clear.boundingBox())!;
      await page.mouse.click(
        box.x + box.width / 2 + dx,
        box.y + box.height / 2 + dy,
      );

      await expect(label).toHaveText("Select a field…");
      // The tell of the bug: the click fell through to the select.
      await expect(page.locator(".p-select-overlay")).toHaveCount(0);
    }
  });

  /** It refused input while looking ready to take it. */
  test("shows the value box as disabled until a field is chosen", async ({
    page,
  }) => {
    await openAdvanced(page);

    const look = await page.evaluate(() => {
      const input = document.querySelector(
        "#events-filter-payload-value",
      ) as HTMLInputElement;
      return {
        disabled: input.disabled,
        opacity: Number(getComputedStyle(input).opacity),
        cursor: getComputedStyle(input).cursor,
      };
    });

    expect(look.disabled).toBe(true);
    expect(look.opacity).toBeLessThan(1);
    expect(look.cursor).toBe("not-allowed");
  });
});

/**
 * The stacking rule is a `@container` query, and for a while nothing between
 * the row and the page declared a container — so it matched nothing and the
 * row never stacked. A container query with no container fails silently, which
 * is the whole reason this is asserted rather than assumed.
 */
test.describe("payload filter on a phone", () => {
  test.use({ viewport: { width: 430, height: 900 } });

  test("stacks instead of crushing two controls into one row", async ({
    page,
  }) => {
    await openAdvanced(page);

    const layout = await page.evaluate(() => {
      const key = document
        .querySelector("p-select.events-payload-filter__key")!
        .getBoundingClientRect();
      const value = document
        .querySelector("#events-filter-payload-value")!
        .getBoundingClientRect();
      const card = document
        .querySelector(".events-filters-card")!
        .getBoundingClientRect();
      const word = document.querySelector(
        ".events-payload-filter__is",
      ) as HTMLElement;
      return {
        stacked: value.top >= key.bottom - 2,
        wordDisplay: getComputedStyle(word).display,
        overflowsCard: value.right > card.right + 1,
      };
    });

    expect(layout.stacked).toBe(true);
    // "is" reads as noise once the two controls are not on one line.
    expect(layout.wordDisplay).toBe("none");
    expect(layout.overflowsCard).toBe(false);
  });
});
