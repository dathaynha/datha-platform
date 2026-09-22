import { createHmac } from "node:crypto";

/**
 * Mints the browser-side auth state the standalone remote reads.
 *
 * Extracted from global-setup so the call suite can seed **two** identities in
 * one run: a real call needs two people, and one storage state cannot describe
 * both.
 *
 * The browser never verifies a signature — angular-oauth2-oidc only checks that
 * an access token is present and unexpired. The **gateway does**, on every API
 * call, so a spec that wants live responses must be given the gateway's own
 * HS256 secret via `E2E_JWT_SECRET`; with a mocked gateway any value works.
 */
export interface SeedIdentity {
  ownerId: string;
  email: string;
  name: string;
}

export interface StorageState {
  cookies: never[];
  origins: {
    origin: string;
    localStorage: { name: string; value: string }[];
  }[];
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function mintJwt(
  claims: Record<string, unknown>,
  secret: string,
): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** The localStorage view of a signed-in user. */
export function authLocalStorage(
  identity: SeedIdentity,
  secret: string,
): { name: string; value: string }[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const expMs = nowMs + 60 * 60 * 1000;

  const claims = {
    sub: identity.ownerId,
    email: identity.email,
    name: identity.name,
  };
  const accessToken = mintJwt(
    { ...claims, iat: nowSec, exp: nowSec + 3600 },
    secret,
  );
  const idTokenClaims = { ...claims, iat: nowSec, exp: nowSec + 3600 };

  return [
    { name: "access_token", value: accessToken },
    { name: "access_token_stored_at", value: String(nowMs) },
    { name: "expires_at", value: String(expMs) },
    { name: "id_token", value: mintJwt(idTokenClaims, secret) },
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
}

export function storageStateFor(
  identity: SeedIdentity,
  secret: string,
  baseURL: string,
): StorageState {
  return {
    cookies: [],
    origins: [
      { origin: baseURL, localStorage: authLocalStorage(identity, secret) },
    ],
  };
}
