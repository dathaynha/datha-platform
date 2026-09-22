import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Seed an authenticated browser state without a real OAuth round-trip.
 *
 * The shell only checks angular-oauth2-oidc's localStorage view of the world
 * (`hasValidAccessToken()` = access_token present + expires_at in the future);
 * token signatures are never verified in the browser. The gateway DOES verify
 * on API calls, so the JWT is minted with the gateway's claim shape
 * (sub = owner id, email/name; HS256) — set E2E_JWT_SECRET to the gateway's
 * secret when a test needs live API responses, otherwise any value works.
 */

const STORAGE_STATE_PATH = "test-results/.auth/storage-state.json";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mintJwt(claims: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export default function globalSetup(): void {
  const secret = process.env["E2E_JWT_SECRET"] ?? "e2e-local-secret";
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const expMs = nowMs + 60 * 60 * 1000;

  const identity = {
    sub: "google_e2e-test-user",
    email: "e2e@datha.local",
    name: "E2E Tester",
  };

  const accessToken = mintJwt(
    { ...identity, iat: nowSec, exp: nowSec + 3600 },
    secret,
  );
  const idTokenClaims = { ...identity, iat: nowSec, exp: nowSec + 3600 };
  const idToken = mintJwt(idTokenClaims, secret);

  // Keys the shell reads: angular-oauth2-oidc storage + LOCAL_STORAGE_KEY.
  const localStorage = [
    { name: "access_token", value: accessToken },
    { name: "access_token_stored_at", value: String(nowMs) },
    { name: "expires_at", value: String(expMs) },
    { name: "id_token", value: idToken },
    { name: "id_token_claims_obj", value: JSON.stringify(idTokenClaims) },
    { name: "id_token_stored_at", value: String(nowMs) },
    { name: "id_token_expires_at", value: String(expMs) },
    {
      name: "granted_scopes",
      value: JSON.stringify(["openid", "profile", "email"]),
    },
    { name: "authProvider", value: "google" },
    { name: "login_time", value: String(nowMs) },
    { name: "theme", value: "starlight" },
    { name: "lang", value: "en" },
  ];

  const baseURL = process.env["E2E_BASE_URL"] ?? "http://localhost:4000";
  const storageState = {
    cookies: [],
    origins: [{ origin: baseURL, localStorage }],
  };

  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
  writeFileSync(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2));
}

export { STORAGE_STATE_PATH };
