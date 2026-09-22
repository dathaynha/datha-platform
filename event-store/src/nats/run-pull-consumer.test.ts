import type { JetStreamClient, JsMsg } from "@nats-io/jetstream";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPullConsumer } from "./run-pull-consumer";

vi.mock("./get-consumer-with-retry", () => ({
  getConsumerWithRetry: vi.fn(),
}));

import { getConsumerWithRetry } from "./get-consumer-with-retry";

const getConsumerWithRetryMock = vi.mocked(getConsumerWithRetry);

function mockMsg(): JsMsg {
  return {
    nak: vi.fn(),
    ack: vi.fn(),
    term: vi.fn(),
    data: new Uint8Array(),
    subject: "test.subject",
  } as unknown as JsMsg;
}

describe("runPullConsumer", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stop() awaits in-flight message handling before returning", async () => {
    let releaseHandle!: () => void;
    const handleGate = new Promise<void>((resolve) => {
      releaseHandle = resolve;
    });

    getConsumerWithRetryMock.mockResolvedValue({
      fetch: vi.fn().mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {
          yield mockMsg();
        },
      }),
    } as never);

    const handleMessage = vi.fn().mockImplementation(() => handleGate);
    const fastify = {
      log: { info: vi.fn(), error: vi.fn() },
    } as unknown as FastifyInstance;

    const runner = runPullConsumer({
      fastify,
      js: {} as JetStreamClient,
      stream: "EVENTS",
      consumerName: "event-store-ingest",
      startedLog: "started",
      fetchErrorLog: "fetch error",
      crashLog: "crashed",
      handleMessage,
    });

    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalled());

    const stopPromise = runner.stop();
    let stopSettled = false;
    void stopPromise.then(() => {
      stopSettled = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(stopSettled).toBe(false);

    releaseHandle();
    await stopPromise;
    expect(stopSettled).toBe(true);
  });

  it("stop() exits promptly when idle fetch errors after shutdown (simulates nc.drain)", async () => {
    let rejectFetch!: (err: Error) => void;
    const fetchPromise = new Promise<never>((_, reject) => {
      rejectFetch = reject;
    });

    getConsumerWithRetryMock.mockResolvedValue({
      fetch: vi.fn().mockReturnValue(fetchPromise),
    } as never);

    const runner = runPullConsumer({
      fastify: {
        log: { info: vi.fn(), error: vi.fn() },
      } as unknown as FastifyInstance,
      js: {} as JetStreamClient,
      stream: "EVENTS",
      consumerName: "event-store-ingest",
      startedLog: "started",
      fetchErrorLog: "fetch error",
      crashLog: "crashed",
      handleMessage: vi.fn(),
    });

    await vi.waitFor(() => expect(getConsumerWithRetryMock).toHaveBeenCalled());

    const stopPromise = runner.stop();
    rejectFetch(new Error("connection draining"));

    await expect(stopPromise).resolves.toBeUndefined();
  });
});
