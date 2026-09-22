import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from "@angular/core";
import { Router } from "@angular/router";
import {
  type DathaEntraPool,
  type DathaLoginProvider,
  LoginCardComponent,
} from "@datha/platform-ui";
import {
  AuthenticationService,
  AuthProvider,
  type EntraLoginPool,
} from "@services/implementations/authentication.service";

@Component({
  selector: "app-login-page",
  imports: [LoginCardComponent],
  templateUrl: "./login-page.component.html",
  host: { class: "flex min-h-full flex-1" },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPageComponent implements OnInit {
  private readonly authenticationService = inject(AuthenticationService);
  private readonly router = inject(Router);

  readonly loggingInProvider = signal<AuthProvider | null>(null);
  readonly loggingInEntraPool = signal<EntraLoginPool | null>(null);
  readonly busyProvider = computed<DathaLoginProvider | null>(() =>
    this.loggingInProvider() === AuthProvider.GOOGLE ? "google" : null,
  );
  readonly loginError = signal<string | null>(null);

  private isLoggingIn(): boolean {
    return (
      this.loggingInProvider() !== null || this.loggingInEntraPool() !== null
    );
  }

  ngOnInit(): void {
    if (this.authenticationService.isAuthenticated()) {
      void this.router.navigate([""]);
    }
  }

  async loginWithGoogle(): Promise<void> {
    if (this.isLoggingIn()) return;
    try {
      this.loggingInProvider.set(AuthProvider.GOOGLE);
      this.loginError.set(null);
      await this.authenticationService.loginWithProvider(AuthProvider.GOOGLE);
    } catch (error) {
      console.error("Error during google sign-in:", error);
      this.loginError.set("LOGIN.ERROR_GENERIC");
    } finally {
      this.loggingInProvider.set(null);
    }
  }

  async loginWithEntra(pool: DathaEntraPool): Promise<void> {
    if (this.isLoggingIn()) return;
    try {
      this.loggingInEntraPool.set(pool);
      this.loginError.set(null);
      await this.authenticationService.loginWithEntra(pool);
    } catch (error) {
      console.error(`Error during Entra sign-in (${pool}):`, error);
      this.loginError.set("LOGIN.ERROR_GENERIC");
    } finally {
      this.loggingInEntraPool.set(null);
    }
  }
}
