import { mergeByTime, separatorFor } from "./thread-timeline";

interface Row {
  id: string;
  message: { createdAt: string };
  separatorAt: string | null;
  separatorDay: "today" | "yesterday" | "other";
}

const row = (id: string, createdAt: string): Row => ({
  id,
  message: { createdAt },
  separatorAt: null,
  separatorDay: "other",
});

describe("mergeByTime", () => {
  it("interleaves by timestamp rather than appending", () => {
    const messages = [
      row("m1", "2026-09-10T10:00:00.000Z"),
      row("m2", "2026-09-10T10:30:00.000Z"),
    ];
    const calls = [row("c1", "2026-09-10T10:15:00.000Z")];

    expect(mergeByTime(messages, calls).map((r) => r.id)).toEqual([
      "m1",
      "c1",
      "m2",
    ]);
  });

  it("returns the original rows untouched when there is nothing to merge", () => {
    const messages = [row("m1", "2026-09-10T10:00:00.000Z")];
    expect(mergeByTime(messages, [])).toBe(messages);
  });

  it("moves a day separator onto the call that now opens the day", () => {
    // The subtle one. Separators derived over messages alone would leave the
    // marker on m2, which is no longer the first row of that day.
    const messages = [
      row("m1", "2026-09-09T22:00:00.000Z"),
      row("m2", "2026-09-10T09:10:00.000Z"),
    ];
    const calls = [row("c1", "2026-09-10T09:00:00.000Z")];

    const merged = mergeByTime(messages, calls);

    expect(merged.map((r) => r.id)).toEqual(["m1", "c1", "m2"]);
    expect(merged[1].separatorAt)
      .withContext("the call opens the new day")
      .toBe("2026-09-10T09:00:00.000Z");
    expect(merged[2].separatorAt)
      .withContext("the message no longer opens it")
      .toBeNull();
  });

  it("gives the very first row a separator", () => {
    const merged = mergeByTime(
      [row("m1", "2026-09-10T10:00:00.000Z")],
      [row("c1", "2026-09-10T09:00:00.000Z")],
    );
    expect(merged[0].separatorAt).toBe("2026-09-10T09:00:00.000Z");
  });
});

describe("separatorFor", () => {
  it("marks a resumption after a long pause", () => {
    const { at } = separatorFor(
      "2026-09-10T12:00:00.000Z",
      "2026-09-10T10:00:00.000Z",
    );
    expect(at).toBe("2026-09-10T12:00:00.000Z");
  });

  it("stays quiet inside a continuous conversation", () => {
    const { at } = separatorFor(
      "2026-09-10T10:05:00.000Z",
      "2026-09-10T10:00:00.000Z",
    );
    expect(at).toBeNull();
  });
});
