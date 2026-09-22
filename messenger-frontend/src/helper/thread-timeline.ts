/**
 * Ordering rules for a chat thread: day/gap separators, and folding call
 * history into the message list.
 *
 * Pure functions in their own file so they can be tested directly — the merge
 * is the part of phase 2.5 slice 4 with actual logic in it, and it was
 * unreachable from any spec while it lived inside the page component.
 */

/**
 * A gap this long earns a time separator between messages.
 *
 * Timestamps moved off every bubble and onto hover, so something still has to
 * answer "when was this" at a glance. Both Messenger and Slack solve it the
 * same way: a centred marker when the conversation resumes after a pause.
 */
const SEPARATOR_GAP_MS = 60 * 60 * 1000;

type DayLabel = "today" | "yesterday" | "other";

function dayLabelFor(createdAt: string): DayLabel {
  const current = new Date(createdAt).toDateString();
  const today = new Date();
  if (current === today.toDateString()) return "today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return current === yesterday.toDateString() ? "yesterday" : "other";
}

export function separatorFor(
  createdAt: string,
  previousCreatedAt: string | undefined,
): { at: string | null; day: DayLabel } {
  const day = dayLabelFor(createdAt);
  if (!previousCreatedAt) return { at: createdAt, day };

  const current = new Date(createdAt);
  const previous = new Date(previousCreatedAt);
  const newDay = current.toDateString() !== previous.toDateString();
  const longGap = current.getTime() - previous.getTime() >= SEPARATOR_GAP_MS;
  return { at: newDay || longGap ? createdAt : null, day };
}

/** The shape this module needs from a row: when it happened. */
interface Timed {
  message: { createdAt: string };
  separatorAt: string | null;
  separatorDay: DayLabel;
}

/**
 * Interleaves two already-sorted kinds of row by timestamp and re-derives the
 * separators over the result.
 *
 * Recomputing is the point: a call landing between two messages can be the row
 * a day boundary now falls on, and flags computed over messages alone would
 * leave the marker attached to the wrong one.
 */
export function mergeByTime<T extends Timed>(
  rows: readonly T[],
  extra: readonly T[],
): readonly T[] {
  if (extra.length === 0) return rows;

  const merged = [...rows, ...extra].sort(
    (a, b) => Date.parse(a.message.createdAt) - Date.parse(b.message.createdAt),
  );

  let previousAt: string | undefined;
  return merged.map((row) => {
    const separator = separatorFor(row.message.createdAt, previousAt);
    previousAt = row.message.createdAt;
    return { ...row, separatorAt: separator.at, separatorDay: separator.day };
  });
}
