import { TestBed } from "@angular/core/testing";
import {
  TranslateModule,
  TranslateService,
  TranslateStore,
} from "@ngx-translate/core";
import { registerRemoteTranslations } from "./register-remote-translations";

describe("registerRemoteTranslations", () => {
  let translate: TranslateService;
  let store: TranslateStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
    });
    translate = TestBed.inject(TranslateService);
    store = TestBed.inject(TranslateStore);
  });

  const top = (lang: string): Record<string, unknown> =>
    store.getTranslations(lang) as unknown as Record<string, unknown>;

  it("registers bundles per language", () => {
    registerRemoteTranslations(translate, store, {
      en: { LANDING: { TITLE: "Chatbot" } },
      de: { LANDING: { TITLE: "Chatbot (de)" } },
    });

    expect(top("en")["LANDING"]).toEqual({
      TITLE: "Chatbot",
    });
    expect(top("de")["LANDING"]).toEqual({
      TITLE: "Chatbot (de)",
    });
  });

  it("replaces top-level subtrees instead of deep-merging (no stale keys across remotes)", () => {
    registerRemoteTranslations(translate, store, {
      en: { LANDING: { TITLE: "Chatbot", FLOW: "chat" } },
    });
    registerRemoteTranslations(translate, store, {
      en: { LANDING: { TITLE: "Event Store" } },
    });

    expect(top("en")["LANDING"]).toEqual({
      TITLE: "Event Store",
    });
  });

  /**
   * The bug dathq reported on 2026-09-20, with a screenshot.
   *
   * The shell owns the profile menu and alone defines `PROFILE.SUPPORT`. Every
   * remote must ship a `PROFILE` block regardless, because this library
   * hardcodes those keys so a remote works standalone — so replacing the
   * namespace wholesale rendered the raw key `PROFILE.SUPPORT` in the popup
   * for as long as any remote was mounted.
   */
  it("keeps host leaves the remote's namespace does not mention", () => {
    translate.setTranslation(
      "en",
      { PROFILE: { TITLE: "My Profile", SUPPORT: "Email Support" } },
      true,
    );

    registerRemoteTranslations(translate, store, {
      en: { PROFILE: { TITLE: "Signed in as" } },
    });

    expect(top("en")["PROFILE"]).toEqual({
      // The remote's wording wins where both define a leaf...
      TITLE: "Signed in as",
      // ...and the host's survives where only it does.
      SUPPORT: "Email Support",
    });
  });

  // The host baseline is what a remote merges over, so a second remote must not
  // inherit the first one's leaves even inside a namespace the host also owns.
  it("does not carry one remote's leaves into another's namespace", () => {
    translate.setTranslation(
      "en",
      { PROFILE: { SUPPORT: "Email Support" } },
      true,
    );

    registerRemoteTranslations(translate, store, {
      en: { PROFILE: { TITLE: "Chatbot", EXTRA: "only chatbot" } },
    });
    registerRemoteTranslations(translate, store, {
      en: { PROFILE: { TITLE: "Event Store" } },
    });

    expect(top("en")["PROFILE"]).toEqual({
      SUPPORT: "Email Support",
      TITLE: "Event Store",
    });
  });

  it("keeps unrelated top-level keys from earlier registrations", () => {
    registerRemoteTranslations(translate, store, {
      en: { CHAT: { SEND: "Send" } },
    });
    registerRemoteTranslations(translate, store, {
      en: { EVENTS: { REPLAY: "Replay" } },
    });

    expect(top("en")["CHAT"]).toEqual({ SEND: "Send" });
    expect(top("en")["EVENTS"]).toEqual({ REPLAY: "Replay" });
  });
});
