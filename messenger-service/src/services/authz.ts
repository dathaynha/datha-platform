import type { Pool } from "pg";
import type { ParticipantRole } from "../types/messenger";

/**
 * The authorization seam. The `input` shape is fixed by
 * `products/messenger-architecture.md` § Identity and authorization so that
 * phase 4 can point `can()` at an OPA sidecar without the schema moving:
 * facts stay here (Postgres membership), the decision moves to Rego.
 */

export type AuthzAction =
  | "conversation.read"
  | "conversation.write"
  | "message.send"
  | "message.read"
  | "call.invite"
  | "call.join";

export interface AuthzSubject {
  owner_id: string;
  tenant_id: string;
  roles: string[];
}

export interface AuthzResource {
  type: "conversation" | "call";
  id: string;
  tenant_id: string;
  participants: string[];
}

export interface AuthzInput {
  subject: AuthzSubject;
  action: AuthzAction;
  resource: AuthzResource;
}

/**
 * Pure decision over facts the caller already loaded — no I/O, so it is
 * exhaustively testable and swappable for a policy call.
 */
export function can(input: AuthzInput): boolean {
  const { subject, action, resource } = input;

  if (subject.tenant_id !== resource.tenant_id) return false;
  if (!resource.participants.includes(subject.owner_id)) return false;

  // Renaming a group or adding members is an admin action; everything else a
  // participant may do by virtue of being one.
  if (action === "conversation.write") {
    return subject.roles.includes("admin");
  }
  return true;
}

export interface ConversationFacts {
  tenantId: string;
  type: "direct" | "group";
  participants: string[];
  /** Role of the asking owner in this conversation, absent when not a member. */
  role: ParticipantRole | null;
}

/**
 * Loads the facts `can()` needs for one conversation. Returns null when the
 * conversation does not exist or was deleted — callers turn both that and a
 * denied decision into 404, never 403: a 403 confirms the id exists.
 */
export async function loadConversationFacts(
  db: Pool,
  conversationId: string,
  ownerId: string,
): Promise<ConversationFacts | null> {
  const { rows } = await db.query<{
    tenant_id: string;
    type: "direct" | "group";
    participants: string[];
    role: ParticipantRole | null;
  }>(
    `SELECT c.tenant_id,
            c.type,
            COALESCE(
              ARRAY_AGG(p.owner_id) FILTER (WHERE p.left_at IS NULL),
              '{}'
            ) AS participants,
            MAX(p.role) FILTER (WHERE p.owner_id = $2 AND p.left_at IS NULL) AS role
       FROM conversations c
       LEFT JOIN conversation_participants p ON p.conversation_id = c.id
      WHERE c.id = $1 AND c.deleted_at IS NULL
      GROUP BY c.tenant_id, c.type`,
    [conversationId, ownerId],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    tenantId: row.tenant_id,
    type: row.type,
    participants: row.participants,
    role: row.role,
  };
}

export interface AuthorizeResult {
  allowed: boolean;
  facts: ConversationFacts | null;
}

/** Loads facts and decides in one call — the shape every route needs. */
export async function authorizeConversation(
  db: Pool,
  params: {
    conversationId: string;
    ownerId: string;
    tenantId: string;
    action: AuthzAction;
  },
): Promise<AuthorizeResult> {
  const facts = await loadConversationFacts(
    db,
    params.conversationId,
    params.ownerId,
  );
  if (!facts) return { allowed: false, facts: null };

  const allowed = can({
    subject: {
      owner_id: params.ownerId,
      tenant_id: params.tenantId,
      roles: facts.role ? [facts.role] : [],
    },
    action: params.action,
    resource: {
      type: "conversation",
      id: params.conversationId,
      tenant_id: facts.tenantId,
      participants: facts.participants,
    },
  });

  return { allowed, facts };
}
