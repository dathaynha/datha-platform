import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import streamPlugin, { type StreamSubscriber } from "./stream";

type NotificationStream = FastifyInstance["notificationStream"];

function subscriber(): StreamSubscriber & {
  send: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  return { send: vi.fn(), end: vi.fn() };
}

describe("notification stream plugin", () => {
  let stream: NotificationStream;
  let onClose: () => Promise<void>;
  const gauge = { inc: vi.fn(), dec: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    const fastify = {
      decorate: (_name: string, value: NotificationStream) => {
        stream = value;
      },
      addHook: (_name: string, fn: () => Promise<void>) => {
        onClose = fn;
      },
      metrics: { sseConnections: gauge },
    } as unknown as FastifyInstance;
    await streamPlugin(fastify);
  });

  it("delivers published notifications only to the matching owner", () => {
    const mine = subscriber();
    const other = subscriber();
    stream.subscribe("owner-a", mine);
    stream.subscribe("owner-b", other);

    stream.publish("owner-a", { id: "n1" });

    expect(mine.send).toHaveBeenCalledWith(JSON.stringify({ id: "n1" }));
    expect(other.send).not.toHaveBeenCalled();
  });

  it("publish to an owner with no subscribers is a no-op", () => {
    expect(() => stream.publish("nobody", { id: "n1" })).not.toThrow();
  });

  it("fans out to every connection of the same owner", () => {
    const tabA = subscriber();
    const tabB = subscriber();
    stream.subscribe("owner-a", tabA);
    stream.subscribe("owner-a", tabB);

    stream.publish("owner-a", { id: "n1" });

    expect(tabA.send).toHaveBeenCalledTimes(1);
    expect(tabB.send).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops delivery and is idempotent on the gauge", () => {
    const sub = subscriber();
    const unsubscribe = stream.subscribe("owner-a", sub);
    expect(gauge.inc).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe();

    stream.publish("owner-a", { id: "n1" });
    expect(sub.send).not.toHaveBeenCalled();
    expect(gauge.dec).toHaveBeenCalledTimes(1);
  });

  it("ends every open connection on shutdown", async () => {
    const a = subscriber();
    const b = subscriber();
    stream.subscribe("owner-a", a);
    stream.subscribe("owner-b", b);

    await onClose();

    expect(a.end).toHaveBeenCalled();
    expect(b.end).toHaveBeenCalled();
  });
});
