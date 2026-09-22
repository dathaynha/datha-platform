import { authedTest as test, expect } from "../fixtures";
import {
  ASSISTANT_MESSAGE_ID,
  CONVERSATION_ID,
  JOB_ID,
  mockChatApi,
  openStubbedThread,
  USER_MESSAGE_ID,
} from "../chat-api-mock";

/**
 * Stream re-attach on revisit: reopening a thread whose generation is still
 * running replays the Redis Stream from entry 0, rebuilding the partial answer.
 */

const RUNNING_JOB = {
  job_id: JOB_ID,
  user_message_id: USER_MESSAGE_ID,
  status: "processing" as const,
  stream_token: "e2e-stream-token",
};

const HISTORY_WITH_PENDING_TURN = [
  { id: USER_MESSAGE_ID, role: "user" as const, content: "Explain SSE replay" },
];

test("re-attaches to a running generation and shows the streamed text", async ({
  page,
}) => {
  await mockChatApi(page, {
    messages: HISTORY_WITH_PENDING_TURN,
    activeJob: RUNNING_JOB,
    streamEvents: [
      { type: "claimed" },
      { type: "chunk", text: "Replayed " },
      { type: "chunk", text: "from entry zero." },
    ],
  });

  await openStubbedThread(page);

  // The user turn comes from history; the assistant text only exists in the stream.
  await expect(page.getByText("Explain SSE replay")).toBeVisible();
  await expect(page.getByText("Replayed from entry zero.")).toBeVisible();
});

test("a finished generation leaves the thread untouched (204)", async ({
  page,
}) => {
  await mockChatApi(page, {
    messages: [
      ...HISTORY_WITH_PENDING_TURN,
      {
        id: ASSISTANT_MESSAGE_ID,
        role: "assistant" as const,
        content: "Answer already persisted.",
      },
    ],
    activeJob: null,
  });

  const streamRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/stream/")) {
      streamRequests.push(req.url());
    }
  });

  await openStubbedThread(page);

  await expect(page.getByText("Answer already persisted.")).toBeVisible();
  // Nothing running → no stream must be opened at all.
  expect(streamRequests).toEqual([]);
  await expect(page.locator(".chat-bubble--typing")).toBeHidden();
});

test("a stream that is already gone leaves no empty placeholder", async ({
  page,
}) => {
  // active-job said "running", but the stream expired before it could be opened.
  await mockChatApi(page, {
    messages: HISTORY_WITH_PENDING_TURN,
    activeJob: RUNNING_JOB,
  });
  await page.route("**/api/chatbot/v1/stream/**", (route) =>
    route.fulfill({ status: 404, json: { detail: "job not found" } }),
  );

  await openStubbedThread(page);

  await expect(page.getByText("Explain SSE replay")).toBeVisible();
  await expect(page.locator(".chat-bubble--assistant")).toHaveCount(0);
  await expect(page.locator(".chat-bubble--typing")).toBeHidden();
});

test("replay ending in done keeps a single assistant bubble", async ({
  page,
}) => {
  await mockChatApi(page, {
    messages: HISTORY_WITH_PENDING_TURN,
    activeJob: RUNNING_JOB,
    streamEvents: [
      { type: "chunk", text: "Partial answer" },
      {
        type: "done",
        assistant_message_id: ASSISTANT_MESSAGE_ID,
        full_text: "Partial answer, now complete.",
        conversation_id: CONVERSATION_ID,
        conversation_title: "E2E thread",
      },
    ],
  });

  await openStubbedThread(page);

  await expect(page.getByText("Partial answer, now complete.")).toBeVisible();
  await expect(page.locator(".chat-bubble--assistant")).toHaveCount(1);
  await expect(page.locator(".chat-bubble--typing")).toBeHidden();
});
