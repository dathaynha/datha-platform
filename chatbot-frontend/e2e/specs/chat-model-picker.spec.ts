import { authedTest as test, expect } from "../fixtures";
import { dismissGlobalErrorDialog, mockChatApi } from "../chat-api-mock";

/**
 * Model picker: listing, search, selection, persistence, fallback.
 *
 * The UI shortens labels for the narrow trigger (`shortModelDisplayName` strips a
 * leading "Gemini "), so assertions use the rendered short names.
 */

const MODELS = [
  { id: "gemini-flash-latest", display_name: "Gemini Flash" },
  { id: "gemini-pro-latest", display_name: "Gemini Pro" },
  { id: "gemini-nano-latest", display_name: "Gemini Nano" },
];

const STORAGE_KEY = "chatbot.selectedModel";

test("lists models and picks one, persisting the choice", async ({ page }) => {
  await mockChatApi(page, { models: MODELS });
  await page.goto("/chat");

  await page.getByRole("button", { name: "Model" }).click();

  const options = page.getByRole("option");
  await expect(options).toHaveCount(MODELS.length);

  await page.getByRole("option", { name: "Pro", exact: true }).click();

  await expect(page.getByRole("option")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY))
    .toBe("gemini-pro-latest");
});

test("filters the list by search text", async ({ page }) => {
  await mockChatApi(page, { models: MODELS });
  await page.goto("/chat");

  await page.getByRole("button", { name: "Model" }).click();
  await page.getByPlaceholder("Search models").fill("nano");

  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: "Nano", exact: true }),
  ).toBeVisible();
});

test("restores the persisted model on reload", async ({ page }) => {
  await mockChatApi(page, { models: MODELS });
  await page.goto("/chat");
  await page.evaluate(
    ([k, v]) => localStorage.setItem(k, v),
    [STORAGE_KEY, "gemini-nano-latest"],
  );

  await page.reload();

  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY))
    .toBe("gemini-nano-latest");
  await page.getByRole("button", { name: "Model" }).click();
  await expect(
    page.getByRole("option", { name: "Nano", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("the chosen model is sent with the message", async ({ page }) => {
  const api = await mockChatApi(page, {
    models: MODELS,
    sendStreamEvents: [
      { type: "done", assistant_message_id: "a-1", full_text: "ok" },
    ],
  });
  await page.goto("/chat");

  await page.getByRole("button", { name: "Model" }).click();
  await page.getByRole("option", { name: "Pro", exact: true }).click();

  await page.getByPlaceholder("Write a message…").fill("Which model are you?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => api.postedMessages.length).toBe(1);
  expect(api.postedMessages[0]).toMatchObject({ model: "gemini-pro-latest" });
});

test("a failed model list still allows sending on the default", async ({
  page,
}) => {
  const api = await mockChatApi(page, {
    modelsStatus: 500,
    sendStreamEvents: [
      { type: "done", assistant_message_id: "a-1", full_text: "ok" },
    ],
  });
  await page.goto("/chat");

  await dismissGlobalErrorDialog(page);

  await page.getByPlaceholder("Write a message…").fill("Still works?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => api.postedMessages.length).toBe(1);
  // Falls back to DEFAULT_CHAT_MODEL_ID rather than sending nothing.
  expect(api.postedMessages[0]["model"]).toBe("gemini-3.6-flash");
});

/**
 * A search that matches nothing says so, in the language you are reading.
 *
 * Found by the audit on 2026-09-21, pre-existing: `CHAT.MODEL_SEARCH_EMPTY`
 * is rendered by the picker's `@empty` branch and existed **only in de.json**,
 * so an English reader got the raw key painted into the panel. Nothing throws
 * when a key is missing — ngx-translate renders the key — which is why no
 * check saw it and why the catalogs are now compared key-set to key-set
 * rather than by eye. Same symptom as the `PROFILE.SUPPORT` bug earlier in
 * this wave, a different cause: that one was a merge depth, this one is a
 * string nobody wrote.
 */
test("an empty search says so rather than painting the raw key", async ({
  page,
}) => {
  await mockChatApi(page, { models: MODELS });
  await page.goto("/chat");

  await page.getByRole("button", { name: "Model" }).click();
  await page.getByPlaceholder("Search models").fill("zzzzz-no-such-model");

  await expect(page.getByRole("option")).toHaveCount(0);

  const empty = page.locator(".chat-model-empty");
  await expect(empty).toBeVisible();
  await expect(empty).toHaveText("No matches");
  // The failure mode is specific: a missing key renders as itself.
  await expect(empty).not.toContainText("CHAT.");
});
