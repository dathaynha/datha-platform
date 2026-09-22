// Placeholder — replaced at build time by angular.json fileReplacements:
//   pnpm start                      → environment.dev.ts
//   --configuration=int             → environment.int.ts
//   --configuration=production      → environment.prod.ts
// Copy this file to environment.dev.ts and fill in your local values.
(<any>window).ENV = {
  production: false,
  version: "1.0.0",
  gateway: {
    baseUrl: "http://localhost:8080/api/event-store",
  },
  entraOidc: {
    issuer: "https://login.microsoftonline.com/organizations/v2.0",
    issuerPersonalMicrosoft: "https://login.microsoftonline.com/consumers/v2.0",
    clientId: "YOUR_ENTRA_CLIENT_ID",
    scope: "openid email profile offline_access",
    responseType: "code",
    requireHttps: false,
    redirectUri: "http://localhost:4002",
    tokenProxyUrl: "http://localhost:8080/auth/entra/token",
  },
  googleOidc: {
    issuer: "https://accounts.google.com",
    clientId: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
    scope: "openid email profile",
    responseType: "code",
    requireHttps: false,
    redirectUri: "http://localhost:4002",
    tokenProxyUrl: "http://localhost:8080/auth/google/token",
  },
  oauth: {
    ignoreUrls: {
      urls: [
        "https://oauth2.googleapis.com",
        "https://accounts.google.com",
        "https://login.microsoftonline.com",
      ],
    },
  },
  email: {
    applicationName: "Event Store frontend",
    recipients: ["your-support@example.com"],
  },
  localeMap: {
    en: "en-US",
    de: "de-DE",
  },
};
export const environment = (<any>window).ENV;
