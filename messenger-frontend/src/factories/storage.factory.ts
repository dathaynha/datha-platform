import { OAuthStorage } from "angular-oauth2-oidc";

export const storageFactory = (): OAuthStorage => localStorage;
