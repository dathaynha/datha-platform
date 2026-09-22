/**
 * The platform owner id of the signed-in user.
 *
 * It lives in the **access token**, which api-gateway mints itself with
 * `sub = "google_<sub>"` / `"entra_<oid>"`. The `id_token` is deliberately left
 * as the provider's original — the gateway says so where it builds the token
 * response — so its `sub` is the *raw* provider subject with no prefix.
 *
 * Reading the id_token instead is silently wrong rather than obviously broken:
 * the id never matches any participant, so "which of these two people is me?"
 * always answers "neither", and the UI picks the first participant for
 * everyone. That shipped as three separate-looking bugs (2026-09-10): the wrong
 * name on a direct conversation, your own typing indicator shown back to you,
 * and your own messages rendered as though they were the other person's.
 */
export function ownerIdFromAccessToken(
  token: string | null | undefined,
): string {
  if (!token) return "";
  const payload = token.split(".")[1];
  if (!payload) return "";
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as { sub?: unknown };
    return typeof claims.sub === "string" ? claims.sub : "";
  } catch {
    // A malformed token is an auth problem, not this function's to report:
    // callers treat "" as "not signed in yet".
    return "";
  }
}
