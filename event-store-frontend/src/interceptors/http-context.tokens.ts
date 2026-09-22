import { HttpContextToken } from "@angular/common/http";

/** When true, {@link AuthInterceptor} forwards the error but does not open the global error dialog. */
export const SKIP_GLOBAL_ERROR_DIALOG = new HttpContextToken<boolean>(
  () => false,
);

/**
 * Header form of {@link SKIP_GLOBAL_ERROR_DIALOG}, for requests that cross a
 * Module Federation boundary.
 *
 * An `HttpContextToken` is an object identity, and this remote bundles its own
 * copy of this file — so hosted by the shell, the token set here is a
 * *different* object from the one the shell's interceptor reads, and the
 * opt-out is silently ignored. `HttpClient` is a shared singleton, so the
 * interceptor that owns the dialog is always the shell's. A header is a value
 * rather than an identity, so both sides agree on it. It is stripped before
 * the request leaves the browser.
 */
export const SKIP_ERROR_DIALOG_HEADER = "X-Datha-Quiet-Errors";
