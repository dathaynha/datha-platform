(<any>window).ENV = {
  production: true,
  version: "1.0.0",
  gateway: {
    baseUrl: "https://gateway.example.com/api/chatbot/v1",
    filesBaseUrl: "https://gateway.example.com/api/files",
  },
  entraOidc: {
    issuer: "https://login.microsoftonline.com/organizations/v2.0",
    issuerPersonalMicrosoft: "https://login.microsoftonline.com/consumers/v2.0",
    clientId: "0e2fb7ed-bce2-4956-8a0f-3eac4d7a7c90",
    scope: "openid email profile offline_access",
    responseType: "code",
    requireHttps: true,
    redirectUri: "https://example.com",
    tokenProxyUrl: "https://gateway.example.com/auth/entra/token",
  },
  googleOidc: {
    issuer: "https://accounts.google.com",
    clientId:
      "754070517479-usavdv7f35ik676f4ku074eni40iuh37.apps.googleusercontent.com",
    scope: "openid email profile",
    responseType: "code",
    requireHttps: true,
    redirectUri: "https://example.com",
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
    applicationName: "Chatbot frontend",
    recipients: ["dathq1999@gmail.com", "dathaynha@gmail.com"],
  },
  localeMap: {
    en: "en-US",
    de: "de-DE",
  },
};
export const environment = (<any>window).ENV;
