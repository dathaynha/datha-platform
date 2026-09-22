import { authedTest as test, expect } from "../fixtures";
import { mockBackend } from "../mock-backend";

/**
 * The call dock has to fit the screen it takes over.
 *
 * Reported 2026-09-21 with a screenshot of a video call on a 375px phone: the
 * stage ran off the right edge and its pin control was clipped. The desktop
 * stage is defined by four insets (`inset: 1.25rem`) with `width: auto`; the
 * phone rule overrode the *size* to 100% and left the inset alone, so
 * `left: 20px` plus `width: 375px` put the right edge at **395px** and the
 * bottom at **687px**. When both insets and a width are set the width wins
 * and `right` is ignored, which is why it overflowed instead of fitting.
 *
 * What this spec is and is not: it measures the **stylesheet's** geometry for
 * each dock state, by stamping the component's own encapsulation attribute
 * onto a probe element inside the live dock host. That is a real measurement
 * of the rules that shipped — an unstamped element gets none of them, which
 * is the `_ngcontent` trap this workspace has paid for repeatedly. It is not
 * a live call: the end-to-end path is `call.spec.ts`, which needs the
 * gateway's real JWT secret and runs in the nightly tier. So this pins the
 * box, and that one pins the behaviour.
 */

const PHONE = { width: 375, height: 667 };

type Rect = { left: number; right: number; top: number; bottom: number };

const dockRects = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const host = document.querySelector("body > messenger-call-dock");
    if (!host) throw new Error("call dock host is not mounted");
    // `Array.from`, not spread: `NamedNodeMap` is array-like but not iterable
    // under this tsconfig's lib, which the browser does not care about and
    // `tsc` rightly does.
    const attr = Array.from(host.attributes)
      .map((a) => a.name)
      .find((n) => n.startsWith("_nghost"))
      ?.replace("_nghost", "_ngcontent");
    if (!attr) throw new Error("call dock has no encapsulation attribute");

    const base =
      "call-dock fixed z-50 flex flex-col gap-3 rounded-2xl border p-4 shadow-lg";
    const measure = (cls: string) => {
      const el = document.createElement("div");
      el.className = cls;
      el.setAttribute(attr, "");
      host.appendChild(el);
      const b = el.getBoundingClientRect();
      el.remove();
      return {
        left: Math.round(b.left),
        right: Math.round(b.right),
        top: Math.round(b.top),
        bottom: Math.round(b.bottom),
      };
    };
    return {
      stage: measure(`${base} is-stage`),
      ring: measure(`${base} is-ring`),
      docked: measure(base),
    };
  });

test.describe("the call dock on a phone", () => {
  test.use({ viewport: PHONE });

  test("keeps every state inside the viewport", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/chats");
    // The host is always mounted and always hidden until a call exists, so
    // wait for attachment rather than visibility.
    await page
      .locator("body > messenger-call-dock")
      .waitFor({ state: "attached", timeout: 15_000 });

    const rects = await dockRects(page);

    for (const [name, r] of Object.entries(rects) as [string, Rect][]) {
      expect(r.left, `${name} left`).toBeGreaterThanOrEqual(0);
      expect(r.right, `${name} right`).toBeLessThanOrEqual(PHONE.width);
      expect(r.top, `${name} top`).toBeGreaterThanOrEqual(0);
      expect(r.bottom, `${name} bottom`).toBeLessThanOrEqual(PHONE.height);
    }

    // The stage is a full-bleed takeover here — `border-radius: 0` already
    // said so, and the inset is what used to stop it being one.
    expect(rects.stage).toEqual({
      left: 0,
      top: 0,
      right: PHONE.width,
      bottom: PHONE.height,
    });
  });
});

test.describe("the call dock with room", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps its margin, so the stage reads as a panel", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/chats");
    await page
      .locator("body > messenger-call-dock")
      .waitFor({ state: "attached", timeout: 15_000 });

    const { stage } = await dockRects(page);
    // 1.25rem on every side: a takeover with a margin, not a full bleed.
    expect(stage).toEqual({ left: 20, top: 20, right: 1260, bottom: 780 });
  });
});
