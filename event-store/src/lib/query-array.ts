/** Normalize repeated query params (`?x=a&x=b`) or comma-separated values into a deduped list. */
export function parseQueryStringArray(
  value: string | string[] | undefined,
): string[] | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parts = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    String(entry)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (parts.length === 0) {
    return undefined;
  }

  return [...new Set(parts)];
}
