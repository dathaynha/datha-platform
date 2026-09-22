(<any>window).ENV = {
  production: true,
  version: "1.0.0",
  // Web Push (public VAPID key — pairs with notification-service's private key).
  push: {
    vapidPublicKey:
      "BGiG7FzvfqNVOO5aF_5D5oCzqGVSPPhyBstq7CpRhv-qMmT3gvX6BWMmFyiBtMrY9BkqAVgedDErkip8Jhianqc",
  },
  gateway: {
    baseUrl: "https://api.example.com",
    filesBaseUrl: "https://api.example.com/api/files",
  },
  entraOidc: {
    issuer: "https://login.microsoftonline.com/organizations/v2.0",
    issuerPersonalMicrosoft: "https://login.microsoftonline.com/consumers/v2.0",
    clientId: "YOUR_ENTRA_CLIENT_ID",
    scope: "openid email profile offline_access",
    responseType: "code",
    requireHttps: true,
    redirectUri: "https://shell.example.com",
    tokenProxyUrl: "https://api.example.com/auth/entra/token",
  },
  googleOidc: {
    issuer: "https://accounts.google.com",
    clientId: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
    scope: "openid email profile",
    responseType: "code",
    requireHttps: true,
    redirectUri: "https://shell.example.com",
    tokenProxyUrl: "https://api.example.com/auth/google/token",
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
    applicationName: "Platform",
    recipients: ["your-support@example.com"],
  },
  localeMap: {
    en: "en-US",
    de: "de-DE",
  },
  // Routing config only — tile name/description come from APPS.* i18n keys,
  // derived from remoteName (chatbot -> APPS.CHATBOT).
  apps: [
    {
      icon: "pi-microchip-ai",
      route: "/chatbot",
      remoteName: "chatbot",
    },
    {
      icon: "pi-database",
      route: "/event-store",
      remoteName: "event-store",
    },
    {
      icon: "pi-comments",
      route: "/messenger",
      remoteName: "messenger",
    },
  ],
  remotes: {
    chatbot: "https://chatbot.example.com/remoteEntry.js",
    "event-store": "https://event-store.example.com/remoteEntry.js",
    messenger: "https://messenger.example.com/remoteEntry.js",
  },
  /**
   * Remote-owned widgets rendered in the shell header, ascending by `order`.
   * Ambient products live here instead of `apps` — see HeaderWidgetDescriptor.
   */
  headerWidgets: [
    {
      remoteName: "messenger",
      exposedModule: "./HeaderWidget",
      order: 20,
    },
  ],
};
export const environment = (<any>window).ENV;
