(<any>window).ENV = {
  production: true,
  version: "1.0.0",
  gateway: {
    baseUrl: "https://gateway.example.com/api/event-store",
  },
  entraOidc: {
    issuer: "https://login.microsoftonline.com/organizations/v2.0",
    issuerPersonalMicrosoft: "https://login.microsoftonline.com/consumers/v2.0",
    clientId: "YOUR_ENTRA_CLIENT_ID",
    scope: "openid email profile offline_access",
    responseType: "code",
    requireHttps: true,
    redirectUri: "https://event-store.example.com",
    tokenProxyUrl: "https://gateway.example.com/auth/entra/token",
  },
  googleOidc: {
    issuer: "https://accounts.google.com",
    clientId: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
    scope: "openid email profile",
    responseType: "code",
    requireHttps: true,
    redirectUri: "https://event-store.example.com",
    tokenProxyUrl: "https://gateway.example.com/auth/google/token",
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
