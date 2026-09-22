import { HttpClient, HttpContext, HttpHeaders } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { map, of, type Observable } from "rxjs";
import { environment } from "src/environments/environment";
import {
  SKIP_ERROR_DIALOG_HEADER,
  SKIP_GLOBAL_ERROR_DIALOG,
} from "src/interceptors/http-context.tokens";
import type { CallRecord, IceCredentials } from "src/models/call.model";
import type { AttachmentGrant } from "src/models/file-service.model";
import type {
  Conversation,
  ConversationParticipant,
  DirectoryUser,
  Message,
} from "src/models/messenger.model";

interface Envelope<T> {
  data: T;
  meta?: { next_cursor: string | null };
}

export interface MessagePage {
  messages: Message[];
  nextCursor: string | null;
}

/**
 * REST client for the Messenger write path.
 *
 * Sending is REST rather than a socket frame on purpose: a durable write must
 * be retriable, and `clientMessageId` makes the retry idempotent
 * (`services/messenger-service-architecture.md` § Transport). The socket is
 * only ever a read path.
 *
 * The directory lives in accounts-service, so people search goes to
 * `/api/accounts/users` — a second base URL, not a second copy of the data.
 */
@Injectable({ providedIn: "root" })
export class MessengerApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.gateway.baseUrl;
  /** …/api/messenger → …/api/accounts, derived so one host change moves both. */
  private readonly accountsBase = environment.gateway.baseUrl.replace(
    /\/api\/messenger$/,
    "/api/accounts",
  );

  /**
   * Chat is a live surface that reloads on its own, so a failure here must not
   * raise the global modal: it would land over the thread on every dropped
   * request and on every reconnect. Failures surface inline instead — an error
   * notice on the list, a retry affordance on the message.
   */
  private readonly quiet = new HttpContext().set(
    SKIP_GLOBAL_ERROR_DIALOG,
    true,
  );

  /**
   * The same intent in header form, because an HttpContextToken does not
   * survive the Module Federation boundary: hosted by the shell, the
   * interceptor that owns the dialog is the shell's and reads its own token
   * object. The header is a value, so both sides agree — and the interceptor
   * strips it before the request is sent.
   */
  private readonly quietHeaders = new HttpHeaders().set(
    SKIP_ERROR_DIALOG_HEADER,
    "1",
  );

  listConversations(limit = 30): Observable<Conversation[]> {
    return this.http
      .get<Envelope<Conversation[]>>(`${this.base}/conversations`, {
        params: { limit },
        context: this.quiet,
        headers: this.quietHeaders,
      })
      .pipe(map((response) => response?.data ?? []));
  }

  getConversation(conversationId: string): Observable<Conversation> {
    return this.http
      .get<Envelope<Conversation>>(
        `${this.base}/conversations/${conversationId}`,
      )
      .pipe(map((response) => response.data));
  }

  /** Idempotent for a direct pair: the same two people always get one thread. */
  createDirectConversation(otherOwnerId: string): Observable<Conversation> {
    return this.http
      .post<Envelope<Conversation>>(
        `${this.base}/conversations`,
        { type: "direct", participant_owner_ids: [otherOwnerId] },
        { context: this.quiet, headers: this.quietHeaders },
      )
      .pipe(map((response) => response.data));
  }

  /**
   * Creates a group. Not idempotent, unlike the direct pair: the same people
   * may have any number of separate groups, so the server has nothing to
   * deduplicate on and every call is a new conversation.
   */
  createGroupConversation(
    participantOwnerIds: readonly string[],
    title: string,
  ): Observable<Conversation> {
    return this.http
      .post<Envelope<Conversation>>(
        `${this.base}/conversations`,
        {
          type: "group",
          participant_owner_ids: [...participantOwnerIds],
          // An absent title is what makes the server leave it null, which is
          // what makes the list fall back to the participants' names.
          ...(title.trim() ? { title: title.trim() } : {}),
        },
        { context: this.quiet, headers: this.quietHeaders },
      )
      .pipe(map((response) => response.data));
  }

  /** Admin-only server-side; null clears the title back to derived names. */
  renameConversation(
    conversationId: string,
    title: string | null,
  ): Observable<Conversation> {
    return this.http
      .patch<Envelope<Conversation>>(
        `${this.base}/conversations/${conversationId}`,
        { title },
        { context: this.quiet, headers: this.quietHeaders },
      )
      .pipe(map((response) => response.data));
  }

  /** Admin-only server-side. Returns the full participant list, not the delta. */
  addParticipants(
    conversationId: string,
    ownerIds: readonly string[],
  ): Observable<ConversationParticipant[]> {
    return this.http
      .post<Envelope<ConversationParticipant[]>>(
        `${this.base}/conversations/${conversationId}/participants`,
        { owner_ids: [...ownerIds] },
        { context: this.quiet, headers: this.quietHeaders },
      )
      .pipe(map((response) => response?.data ?? []));
  }

  /** Leaves a conversation. 204 on success; the row goes with it. */
  leaveConversation(conversationId: string): Observable<void> {
    return this.http
      .delete<void>(
        `${this.base}/conversations/${conversationId}/participants/me`,
        { context: this.quiet, headers: this.quietHeaders },
      )
      .pipe(map(() => undefined));
  }

  listMessages(
    conversationId: string,
    options: { limit?: number; before?: string } = {},
  ): Observable<MessagePage> {
    const params: Record<string, string | number> = {
      limit: options.limit ?? 50,
    };
    if (options.before) params["before"] = options.before;

    return this.http
      .get<Envelope<Message[]>>(
        `${this.base}/conversations/${conversationId}/messages`,
        { params, context: this.quiet, headers: this.quietHeaders },
      )
      .pipe(
        map((response) => ({
          messages: response?.data ?? [],
          nextCursor: response?.meta?.next_cursor ?? null,
        })),
      );
  }

  sendMessage(
    conversationId: string,
    payload: {
      clientMessageId: string;
      body: string;
      attachmentFileId?: string;
      /** A downscaled copy of an image attachment, uploaded alongside it. */
      thumbnailFileId?: string;
      mediaWidth?: number;
      mediaHeight?: number;
    },
  ): Observable<Message> {
    return this.http
      .post<Envelope<Message>>(
        `${this.base}/conversations/${conversationId}/messages`,
        {
          client_message_id: payload.clientMessageId,
          body: payload.body,
          ...(payload.attachmentFileId
            ? { attachment_file_id: payload.attachmentFileId }
            : {}),
          ...(payload.thumbnailFileId
            ? { thumbnail_file_id: payload.thumbnailFileId }
            : {}),
          ...(payload.mediaWidth && payload.mediaHeight
            ? {
                media_width: payload.mediaWidth,
                media_height: payload.mediaHeight,
              }
            : {}),
        },
        { context: this.quiet, headers: this.quietHeaders },
      )
      .pipe(map((response) => response.data));
  }

  /** Advances the durable read watermark; the badge follows over the socket. */
  markRead(conversationId: string, messageId: string): Observable<void> {
    return this.http
      .post<Envelope<{ last_read_at: string }>>(
        `${this.base}/conversations/${conversationId}/read`,
        { message_id: messageId },
        { context: this.quiet, headers: this.quietHeaders },
      )
      .pipe(map(() => undefined));
  }

  searchDirectory(query: string, limit = 10): Observable<DirectoryUser[]> {
    return this.http
      .get<Envelope<DirectoryUser[]>>(`${this.accountsBase}/users`, {
        params: { q: query, limit },
        context: this.quiet,
        headers: this.quietHeaders,
      })
      .pipe(map((response) => response?.data ?? []));
  }

  lookupUsers(ownerIds: readonly string[]): Observable<DirectoryUser[]> {
    // The endpoint requires a non-empty list, so an empty ask is answered here.
    if (ownerIds.length === 0) {
      return of([]);
    }
    return this.http
      .get<Envelope<DirectoryUser[]>>(`${this.accountsBase}/users/lookup`, {
        params: { owner_ids: [...ownerIds].join(",") },
        context: this.quiet,
        headers: this.quietHeaders,
      })
      .pipe(map((response) => response?.data ?? []));
  }

  /**
   * A short-lived download URL for a message's attachment.
   *
   * It comes from messenger-service, not file-service: file-service scopes
   * every read by owner, so a recipient could never fetch the sender's blob
   * there. Conversation membership is the right authorization and only
   * messenger-service knows it.
   */
  attachmentGrant(
    conversationId: string,
    messageId: string,
  ): Observable<AttachmentGrant> {
    return this.http
      .get<{
        data: {
          name: string;
          download_url: string;
          expires_at: string;
          thumbnail_url?: string | null;
          width?: number | null;
          height?: number | null;
        };
      }>(
        `${this.base}/conversations/${conversationId}/messages/${messageId}/attachment`,
        { context: this.quiet, headers: this.quietHeaders },
      )
      .pipe(
        map((response) => ({
          name: response.data.name,
          downloadUrl: response.data.download_url,
          expiresAt: response.data.expires_at,
          thumbnailUrl: response.data.thumbnail_url ?? null,
          width: response.data.width ?? null,
          height: response.data.height ?? null,
        })),
      );
  }

  /**
   * ICE servers for a call, signed per owner by realtime-service.
   *
   * Derived from the token URL rather than added as a third `realtime` entry:
   * both are plain HTTP siblings behind the same gateway path, so one host
   * change moves them together. `socketUrl` stays explicit only because it is
   * `ws://` and cannot be derived from an `http://` one.
   */
  turnCredentials(): Observable<IceCredentials> {
    const url = environment.realtime.tokenUrl.replace(
      /\/token$/,
      "/turn-credentials",
    );
    return this.http
      .get<{
        data: { ice_servers: RTCIceServer[]; ttl: number; relay: boolean };
      }>(url, { context: this.quiet, headers: this.quietHeaders })
      .pipe(
        map((response) => ({
          iceServers: response.data.ice_servers ?? [],
          ttl: response.data.ttl ?? 0,
          relay: response.data.relay === true,
        })),
      );
  }

  /** This user's call history across conversations, newest first. */
  listCalls(limit = 50): Observable<CallRecord[]> {
    return this.http
      .get<Envelope<CallRecord[]>>(`${this.base}/calls`, {
        params: { limit },
        context: this.quiet,
        headers: this.quietHeaders,
      })
      .pipe(map((response) => response.data ?? []));
  }

  /** One thread's calls. 404s when the caller is not a participant. */
  listConversationCalls(
    conversationId: string,
    limit = 50,
  ): Observable<CallRecord[]> {
    return this.http
      .get<Envelope<CallRecord[]>>(
        `${this.base}/conversations/${conversationId}/calls`,
        { params: { limit }, context: this.quiet, headers: this.quietHeaders },
      )
      .pipe(map((response) => response.data ?? []));
  }
}
