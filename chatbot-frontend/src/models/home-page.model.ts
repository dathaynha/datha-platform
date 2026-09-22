export interface LandingStackCard {
  readonly icon: string;
  readonly title: string;
  readonly descKey: string;
}

/** Themed block under "Tech we use" (e.g. browser vs service plane). */
export interface LandingStackCardGroup {
  readonly headingId: string;
  readonly titleKey: string;
  /** Widest-tier column count for the card grid — a `landing-cards--*` modifier. */
  readonly gridClass: string;
  readonly cards: readonly LandingStackCard[];
}

export type LandingFlowMode = "message" | "delete";

export type LandingFlowNodeId =
  | "angular"
  | "gateway"
  | "fastapi"
  | "file-service"
  | "azure-blob"
  | "nats"
  | "event-store"
  | "postgres"
  | "redis"
  | "worker"
  | "ado";

export interface LandingFlowDetailItem {
  readonly icon: string;
  readonly labelKey: string;
}

export interface LandingFlowNode {
  readonly id: LandingFlowNodeId;
  readonly icon: string;
  readonly titleKey: string;
  readonly descKey: string;
  readonly details: readonly LandingFlowDetailItem[];
}

export type LandingDeleteFlowNodeId =
  | "angular"
  | "gateway"
  | "fastapi"
  | "postgres"
  | "nats"
  | "file-service"
  | "azure-blob"
  | "event-store";

export interface LandingDeleteFlowNode {
  readonly id: LandingDeleteFlowNodeId;
  readonly icon: string;
  readonly titleKey: string;
  readonly descKey: string;
  readonly details: readonly LandingFlowDetailItem[];
}
