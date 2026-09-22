import { describe, expect, it, vi } from "vitest";
import { publishEvent } from "./events.service";

describe("publishEvent", () => {
  it("no-ops when JetStream client is null", async () => {
    await expect(
      publishEvent(null, {
        type: "file.deleted",
        fileId: "f1",
        ownerId: "google_owner",
        mimeType: null,
        blobPath: "path",
        correlationId: null,
        origin: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("publishes to events.file.file.deleted with envelope JSON", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const js = { publish } as unknown as Parameters<typeof publishEvent>[0];

    await publishEvent(js, {
      type: "file.deleted",
      fileId: "f1",
      ownerId: "google_owner",
      mimeType: "application/pdf",
      blobPath: "google_owner/f1/doc.pdf",
      correlationId: "corr-1",
      origin: "messenger",
    });

    expect(publish).toHaveBeenCalledOnce();
    const [subject, payload] = publish.mock.calls[0] as [string, Uint8Array];
    expect(subject).toBe("events.file.file.deleted");
    const envelope = JSON.parse(new TextDecoder().decode(payload)) as {
      type: string;
      owner_id: string;
      service: string;
      payload: { file_id: string; origin: string | null };
    };
    expect(envelope.type).toBe("file.deleted");
    expect(envelope.owner_id).toBe("google_owner");
    expect(envelope.payload.file_id).toBe("f1");
    // `service` names the publisher, which is always this one. `origin` names
    // the product that asked for the file, and without it the event store
    // cannot tell a chatbot attachment from a messenger one.
    expect(envelope.service).toBe("file-service");
    expect(envelope.payload.origin).toBe("messenger");
  });
});
