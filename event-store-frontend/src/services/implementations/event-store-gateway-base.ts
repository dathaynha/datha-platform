import { environment } from "src/environments/environment";

/** Gateway base for event-store routes (`/api/event-store/…`). */
export function eventStoreGatewayBase(): string {
  const base = environment.gateway?.baseUrl?.replace(/\/$/, "");
  if (!base) {
    throw new Error("environment.gateway.baseUrl is not set");
  }
  return base;
}
