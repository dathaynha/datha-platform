export interface LandingStackCard {
  readonly icon: string;
  readonly title: string;
  readonly descKey: string;
}

/** Themed block under "Tech we use" (e.g. browser vs realtime plane). */
export interface LandingStackCardGroup {
  readonly headingId: string;
  readonly titleKey: string;
  /** Widest-tier column count for the card grid — a `landing-cards--*` modifier. */
  readonly gridClass: string;
  readonly cards: readonly LandingStackCard[];
}

export type LandingFlowMode = "message" | "call";

export type LandingMessageFlowNodeId =
  | "composer"
  | "messenger-service"
  | "postgres"
  | "nats"
  | "realtime-service"
  | "recipient";

export type LandingCallFlowNodeId =
  "credentials" | "offer" | "relay" | "ice" | "media" | "turn";

export interface LandingFlowDetailItem {
  readonly icon: string;
  readonly labelKey: string;
}

export interface LandingMessageFlowNode {
  readonly id: LandingMessageFlowNodeId;
  readonly icon: string;
  readonly titleKey: string;
  readonly descKey: string;
  readonly details: readonly LandingFlowDetailItem[];
}

export interface LandingCallFlowNode {
  readonly id: LandingCallFlowNodeId;
  readonly icon: string;
  readonly titleKey: string;
  readonly descKey: string;
  readonly details: readonly LandingFlowDetailItem[];
}

/** A connector between two diagram nodes. */
export interface LandingFlowLink {
  readonly key: string;
  /** A literal — path, subject, method — so it renders verbatim, not uppercased. */
  readonly code: boolean;
}
