import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeConversation,
  can,
  loadConversationFacts,
  type AuthzInput,
} from "./authz";

const BASE: AuthzInput = {
  subject: {
    owner_id: "google_1",
    tenant_id: "datha-platform",
    roles: ["member"],
  },
  action: "message.send",
  resource: {
    type: "conversation",
    id: "c1",
    tenant_id: "datha-platform",
    participants: ["google_1", "google_2"],
  },
};

function mockDb(rows: unknown[]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

describe("can", () => {
  it("allows a participant to send", () => {
    expect(can(BASE)).toBe(true);
  });

  it("denies a non-participant", () => {
    expect(
      can({
        ...BASE,
        subject: { ...BASE.subject, owner_id: "google_9" },
      }),
    ).toBe(false);
  });

  it("denies across tenants even for a listed participant", () => {
    expect(
      can({
        ...BASE,
        subject: { ...BASE.subject, tenant_id: "other-tenant" },
      }),
    ).toBe(false);
  });

  it("requires the admin role to write conversation settings", () => {
    expect(can({ ...BASE, action: "conversation.write" })).toBe(false);
    expect(
      can({
        ...BASE,
        action: "conversation.write",
        subject: { ...BASE.subject, roles: ["admin"] },
      }),
    ).toBe(true);
  });
});

describe("loadConversationFacts", () => {
  it("returns null for a missing or deleted conversation", async () => {
    await expect(
      loadConversationFacts(mockDb([]), "c1", "google_1"),
    ).resolves.toBeNull();
  });

  it("reports the asking owner's role", async () => {
    const db = mockDb([
      {
        tenant_id: "datha-platform",
        type: "group",
        participants: ["google_1", "google_2"],
        role: "admin",
      },
    ]);
    await expect(loadConversationFacts(db, "c1", "google_1")).resolves.toEqual({
      tenantId: "datha-platform",
      type: "group",
      participants: ["google_1", "google_2"],
      role: "admin",
    });
  });
});

describe("authorizeConversation", () => {
  it("denies with no facts when the conversation does not exist", async () => {
    await expect(
      authorizeConversation(mockDb([]), {
        conversationId: "c1",
        ownerId: "google_1",
        tenantId: "datha-platform",
        action: "conversation.read",
      }),
    ).resolves.toEqual({ allowed: false, facts: null });
  });

  it("denies a non-participant but still returns the facts", async () => {
    const db = mockDb([
      {
        tenant_id: "datha-platform",
        type: "direct",
        participants: ["google_2", "google_3"],
        role: null,
      },
    ]);
    const result = await authorizeConversation(db, {
      conversationId: "c1",
      ownerId: "google_1",
      tenantId: "datha-platform",
      action: "conversation.read",
    });
    expect(result.allowed).toBe(false);
    expect(result.facts?.participants).toEqual(["google_2", "google_3"]);
  });
});
