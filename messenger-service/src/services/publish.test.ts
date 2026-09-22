import { describe, expect, it, vi } from "vitest";
import {
  publishEvent,
  publishOwnerFrames,
  SERVICE_NAME,
  type CorePublisher,
} from "./publish";

function decode(data: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
}

describe("publishEvent", () => {
  it("publishes a standard envelope on events.<type>", async () => {
    const js = { publish: vi.fn().mockResolvedValue({ seq: 1 }) };

    const envelope = await publishEvent(js, {
      type: "messenger.message.sent",
      entityId: "m1",
      ownerId: "google_1",
      correlationId: "corr-1",
      payload: { conversation_id: "c1" },
    });

    const [subject, data] = js.publish.mock.calls[0] as [string, Uint8Array];
    expect(subject).toBe("events.messenger.message.sent");
    expect(decode(data)).toMatchObject({
      id: envelope.id,
      type: "messenger.message.sent",
      service: SERVICE_NAME,
      entity_id: "m1",
      owner_id: "google_1",
      correlation_id: "corr-1",
      payload: { conversation_id: "c1" },
    });
    expect(Date.parse(envelope.timestamp)).not.toBeNaN();
  });
});

describe("publishOwnerFrames", () => {
  it("publishes one frame per owner on rt.owner.<id>", () => {
    const nc: CorePublisher = { publish: vi.fn() };

    const result = publishOwnerFrames(nc, ["google_1", "google_2"], {
      t: "unread.added",
      d: { conversation_id: "c1" },
    });

    expect(result).toEqual({ published: 2, failed: 0 });
    expect(vi.mocked(nc.publish).mock.calls.map((c) => c[0])).toEqual([
      "rt.owner.google_1",
      "rt.owner.google_2",
    ]);
  });

  it("counts a failed publish instead of throwing — the write is already durable", () => {
    const nc: CorePublisher = {
      publish: vi.fn().mockImplementation((subject: string) => {
        if (subject === "rt.owner.google_2") throw new Error("closed");
      }),
    };

    const result = publishOwnerFrames(nc, ["google_1", "google_2"], {
      t: "message.new",
      d: {},
    });

    expect(result).toEqual({ published: 1, failed: 1 });
  });
});
