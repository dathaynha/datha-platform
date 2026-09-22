(<any>window).ENV = {
  production: false,
  version: "1.0.0",
  gateway: {
    baseUrl: "https://gateway-int.example.com/api/messenger",
    // Attachment uploads go straight to Azure Blob from the browser via a SAS
    // URL; only the prepare/confirm metadata calls pass through the gateway.
    filesBaseUrl: "https://gateway-int.example.com/api/files",
  },
  // The realtime socket lives behind the same gateway. Its token endpoint is
  // separate from the socket URL because a WebSocket cannot send an
  // Authorization header — the token is minted over HTTP, then rides in the
  // query string for the moment of connect only.
  realtime: {
    tokenUrl: "https://gateway-int.example.com/api/realtime/token",
    socketUrl: "wss://gateway-int.example.com/api/realtime/ws",
  },
  entraOidc: {
    issuer: "https://login.microsoftonline.com/organizations/v2.0",
    issuerPersonalMicrosoft: "https://login.microsoftonline.com/consumers/v2.0",
    clientId: "YOUR_ENTRA_CLIENT_ID",
    scope: "openid email profile offline_access",
    responseType: "code",
    requireHttps: true,
    redirectUri: "https://messenger-int.example.com",
    tokenProxyUrl: "https://gateway-int.example.com/auth/entra/token",
  },
  googleOidc: {
    issuer: "https://accounts.google.com",
    clientId: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
    scope: "openid email profile",
    responseType: "code",
    requireHttps: true,
    redirectUri: "https://messenger-int.example.com",
    tokenProxyUrl: "https://gateway-int.example.com/auth/google/token",
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
    applicationName: "Messenger frontend",
    recipients: ["your-support@example.com"],
  },
  localeMap: {
    en: "en-US",
    de: "de-DE",
  },
};
export const environment = (<any>window).ENV;
