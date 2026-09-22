/**
 * Opaque keyset cursor for the events list.
 *
 * Opaque on purpose: it encodes the sort key, and the sort key is an
 * implementation detail the client must not build, parse or reason about. The
 * moment a caller constructs one by hand, changing the ordering becomes a
 * breaking change to everybody.
 *
 * It is not encrypted and not meant to be — it ends up in a URL, and the worst
 * a reader learns is a timestamp and a row id they were already being shown.
 */
export interface EventCursor {
  timestamp: string;
  id: string;
}

export function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(`${cursor.timestamp}|${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

/**
 * Null for anything that is not a cursor this service issued.
 *
 * A bad cursor is a 400, never a silent fall back to the first page: a deep
 * page that quietly restarts at the top looks like data loss to whoever is
 * reading the list.
 */
export function decodeCursor(raw: string): EventCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const separator = decoded.indexOf("|");
  if (separator <= 0) {
    return null;
  }

  const timestamp = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!id || Number.isNaN(Date.parse(timestamp))) {
    return null;
  }

  return { timestamp, id };
}
