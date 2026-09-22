import { environment } from "src/environments/environment";

/** Gateway base for chatbot-service routes (`/api/chatbot/v1/…` proxied as env `baseUrl`). */
export function chatbotGatewayBase(): string {
  const base = environment.gateway?.baseUrl?.replace(/\/$/, "");
  if (!base) {
    throw new Error("environment.gateway.baseUrl is not set");
  }
  return base;
}
