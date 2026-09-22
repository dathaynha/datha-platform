import { authedTest as test, expect } from "../fixtures";
import {
  dismissGlobalErrorDialog,
  FILE_ID,
  mockChatApi,
} from "../chat-api-mock";

/**
 * Composer attachments: prepare → SAS blob PUT → confirm, then send.
 * The blob PUT goes straight to Azure, so the SAS host is mocked too.
 */

const TXT = {
  name: "note.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("hello attachment"),
};

async function attach(
  page: import("@playwright/test").Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
): Promise<void> {
  // The input is visually hidden (sr-only), so set files on it directly.
  await page.locator('input[type="file"]').setInputFiles(files);
}

test("uploads an attachment and sends it with the message", async ({
  page,
}) => {
  const api = await mockChatApi(page, {
    sendStreamEvents: [
      { type: "done", assistant_message_id: "a-1", full_text: "Got the file." },
    ],
  });

  await page.goto("/chat");
  await attach(page, [TXT]);

  // Chip appears once the pipeline finishes (upload state cleared).
  await expect(page.getByText("note.txt").first()).toBeVisible();

  await page.getByPlaceholder("Write a message…").fill("See attached");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => api.postedMessages.length).toBe(1);
  expect(api.postedMessages[0]["files"]).toEqual([
    { file_id: FILE_ID, name: "note.txt", mime_type: "text/plain" },
  ]);
});

test("removes an attachment before sending", async ({ page }) => {
  const api = await mockChatApi(page, {
    sendStreamEvents: [
      { type: "done", assistant_message_id: "a-1", full_text: "ok" },
    ],
  });

  await page.goto("/chat");
  await attach(page, [TXT]);
  await expect(page.getByText("note.txt").first()).toBeVisible();

  await page.getByRole("button", { name: "Remove attachment" }).click();
  await expect(page.getByText("note.txt")).toHaveCount(0);

  await page.getByPlaceholder("Write a message…").fill("No file now");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => api.postedMessages.length).toBe(1);
  expect(api.postedMessages[0]["files"]).toEqual([]);
});

test("a rejected upload surfaces the failure", async ({ page }) => {
  await mockChatApi(page, { prepareStatus: 500 });

  await page.goto("/chat");
  await attach(page, [TXT]);

  await dismissGlobalErrorDialog(page);
  await expect(page.getByText("Could not upload attachment")).toBeVisible();
});

test("a failed blob PUT surfaces the failure", async ({ page }) => {
  await mockChatApi(page, { blobPutStatus: 403 });

  await page.goto("/chat");
  await attach(page, [TXT]);

  await expect(page.getByText("Could not upload attachment")).toBeVisible();
});

test("rejects a file over the size cap", async ({ page }) => {
  await mockChatApi(page);

  await page.goto("/chat");
  // MAX_CHAT_ATTACHMENT_BYTES is 20 MB.
  await attach(page, [
    {
      name: "huge.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(21 * 1024 * 1024),
    },
  ]);

  await expect(
    page.getByText("Each attachment must be at most 20 MB."),
  ).toBeVisible();
  await expect(page.getByText("huge.bin")).toHaveCount(0);
});

test("shows the per-message attachment limit", async ({ page }) => {
  await mockChatApi(page);
  await page.goto("/chat");

  await expect(
    page.getByText("You can attach up to 10 files per message."),
  ).toBeVisible();
});
