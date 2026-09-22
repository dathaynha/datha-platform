import type { LandingIngestFlowNode } from "@models/home-page.model";

/** Canonical ingest flow — order matches the vertical diagram. */
export const LANDING_INGEST_FLOW_NODES: readonly LandingIngestFlowNode[] = [
  {
    id: "publisher",
    icon: "pi pi-send",
    titleKey: "LANDING.INGEST_FLOW.PUBLISHER.TITLE",
    descKey: "LANDING.INGEST_FLOW.PUBLISHER.DESC",
    details: [
      { icon: "pi pi-server", labelKey: "LANDING.INGEST_FLOW.PUBLISHER.D1" },
      { icon: "pi pi-envelope", labelKey: "LANDING.INGEST_FLOW.PUBLISHER.D2" },
      { icon: "pi pi-share-alt", labelKey: "LANDING.INGEST_FLOW.PUBLISHER.D3" },
    ],
  },
  {
    id: "nats-events",
    icon: "pi pi-share-alt",
    titleKey: "LANDING.INGEST_FLOW.NATS.TITLE",
    descKey: "LANDING.INGEST_FLOW.NATS.DESC",
    details: [
      { icon: "pi pi-inbox", labelKey: "LANDING.INGEST_FLOW.NATS.D1" },
      { icon: "pi pi-filter", labelKey: "LANDING.INGEST_FLOW.NATS.D2" },
      { icon: "pi pi-history", labelKey: "LANDING.INGEST_FLOW.NATS.D3" },
    ],
  },
  {
    id: "ingest",
    icon: "pi pi-download",
    titleKey: "LANDING.INGEST_FLOW.INGEST.TITLE",
    descKey: "LANDING.INGEST_FLOW.INGEST.DESC",
    details: [
      { icon: "pi pi-sync", labelKey: "LANDING.INGEST_FLOW.INGEST.D1" },
      { icon: "pi pi-check", labelKey: "LANDING.INGEST_FLOW.INGEST.D2" },
      { icon: "pi pi-ban", labelKey: "LANDING.INGEST_FLOW.INGEST.D3" },
    ],
  },
  {
    id: "postgres-events",
    icon: "pi pi-table",
    titleKey: "LANDING.INGEST_FLOW.POSTGRES.TITLE",
    descKey: "LANDING.INGEST_FLOW.POSTGRES.DESC",
    details: [
      { icon: "pi pi-search", labelKey: "LANDING.INGEST_FLOW.POSTGRES.D1" },
      { icon: "pi pi-clock", labelKey: "LANDING.INGEST_FLOW.POSTGRES.D2" },
      { icon: "pi pi-link", labelKey: "LANDING.INGEST_FLOW.POSTGRES.D3" },
    ],
  },
];
