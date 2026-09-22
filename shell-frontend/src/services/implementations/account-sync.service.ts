import { HttpClient, HttpContext } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { SKIP_GLOBAL_ERROR_DIALOG } from "src/interceptors/http-context.tokens";
import { environment } from "src/environments/environment";

/**
 * Provisions the signed-in user in `accounts-service`.
 *
 * Nothing else does this, and until it existed **the directory stayed empty**:
 * a user row is only created by this call, so nobody could find anybody to
 * start a conversation with (found 2026-09-09, with zero rows in `users` after
 * six successful logins).
 *
 * Called on every app start rather than only after a fresh login. It is an
 * upsert server-side, so repeating it is free — and that is what makes it
 * self-healing for sessions that predate this code, or that were established
 * while accounts-service was down.
 *
 * Identity is **not** sent: `accounts-service` reads the gateway-injected
 * `X-Owner-ID`, `X-User-Email`, `X-User-Name` and `X-User-Picture`, so a client
 * cannot claim to be someone else.
 */
@Injectable({ providedIn: "root" })
export class AccountSyncService {
  private readonly http = inject(HttpClient);

  /**
   * Silent by design: accounts-service being down must not stack a modal over
   * the app on every load. The cost of failure is a directory row that appears
   * on the next start instead.
   */
  private readonly silentContext = new HttpContext().set(
    SKIP_GLOBAL_ERROR_DIALOG,
    true,
  );

  /** Fire-and-forget; resolves whether or not the sync succeeded. */
  async sync(): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post(
          `${environment.gateway.baseUrl}/api/accounts/users/me/sync`,
          {},
          { context: this.silentContext },
        ),
      );
    } catch (error) {
      console.warn(
        "[shell] account sync failed; this user may not appear in the directory",
        error,
      );
    }
  }
}
