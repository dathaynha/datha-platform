export interface LandingStackCard {
  readonly icon: string;
  readonly title: string;
  readonly descKey: string;
}

/** Themed block under "Tech we use" (e.g. browser vs service plane). */
export interface LandingStackCardGroup {
  readonly headingId: string;
  readonly titleKey: string;
  /**
   * Widest column count this group should ever reach, as a `landing-cards--N`
   * modifier. The breakpoints live in the stylesheet and key on the page
   * container, not the viewport — hosted, the shell's sidebar makes those two
   * disagree by 224px.
   */
  readonly gridClass: string;
  readonly cards: readonly LandingStackCard[];
}

export type LandingFlowMode = "ingest" | "dlq";

export type LandingIngestFlowNodeId =
  "publisher" | "nats-events" | "ingest" | "postgres-events";

export type LandingDlqFlowNodeId =
  | "consumer"
  | "max-deliver"
  | "dlq-publish"
  | "dlq-ingest"
  | "postgres-dlq"
  | "ops-ui";

export interface LandingFlowDetailItem {
  readonly icon: string;
  readonly labelKey: string;
}

export interface LandingIngestFlowNode {
  readonly id: LandingIngestFlowNodeId;
  readonly icon: string;
  readonly titleKey: string;
  readonly descKey: string;
  readonly details: readonly LandingFlowDetailItem[];
}

export interface LandingDlqFlowNode {
  readonly id: LandingDlqFlowNodeId;
  readonly icon: string;
  readonly titleKey: string;
  readonly descKey: string;
  readonly details: readonly LandingFlowDetailItem[];
}
