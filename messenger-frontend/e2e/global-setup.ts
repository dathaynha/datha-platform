import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { storageStateFor } from "./mint-auth";

/**
 * Seed an authenticated browser state without a real OAuth round-trip.
 *
 * The minting itself lives in `mint-auth.ts`, because the call suite seeds two
 * identities of its own — a real call needs two people. See that file for why a
 * fake signature is enough for the browser and not enough for the gateway.
 */

const STORAGE_STATE_PATH = "test-results/.auth/storage-state.json";

export default function globalSetup(): void {
  const secret = process.env["E2E_JWT_SECRET"] ?? "e2e-local-secret";
  const baseURL = process.env["E2E_BASE_URL"] ?? "http://localhost:4003";

  const storageState = storageStateFor(
    {
      ownerId: "google_e2e-test-user",
      email: "e2e@datha.local",
      name: "E2E Tester",
    },
    secret,
    baseURL,
  );

  mkdirSync(dirname(STORAGE_STATE_PATH), { recursive: true });
  writeFileSync(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2));
}

export { STORAGE_STATE_PATH };
