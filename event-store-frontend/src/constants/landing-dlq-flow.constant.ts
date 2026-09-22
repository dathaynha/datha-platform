import type { LandingDlqFlowNode } from "@models/home-page.model";

/** DLQ ops pattern — separate from business ingest; order matches the vertical diagram. */
export const LANDING_DLQ_FLOW_NODES: readonly LandingDlqFlowNode[] = [
  {
    id: "consumer",
    icon: "pi pi-sync",
    titleKey: "LANDING.DLQ_FLOW.CONSUMER.TITLE",
    descKey: "LANDING.DLQ_FLOW.CONSUMER.DESC",
    details: [
      { icon: "pi pi-download", labelKey: "LANDING.DLQ_FLOW.CONSUMER.D1" },
      { icon: "pi pi-replay", labelKey: "LANDING.DLQ_FLOW.CONSUMER.D2" },
      { icon: "pi pi-shield", labelKey: "LANDING.DLQ_FLOW.CONSUMER.D3" },
    ],
  },
  {
    id: "max-deliver",
    icon: "pi pi-exclamation-triangle",
    titleKey: "LANDING.DLQ_FLOW.MAX_DELIVER.TITLE",
    descKey: "LANDING.DLQ_FLOW.MAX_DELIVER.DESC",
    details: [
      { icon: "pi pi-sliders-h", labelKey: "LANDING.DLQ_FLOW.MAX_DELIVER.D1" },
      { icon: "pi pi-times", labelKey: "LANDING.DLQ_FLOW.MAX_DELIVER.D2" },
      { icon: "pi pi-sitemap", labelKey: "LANDING.DLQ_FLOW.MAX_DELIVER.D3" },
    ],
  },
  {
    id: "dlq-publish",
    icon: "pi pi-inbox",
    titleKey: "LANDING.DLQ_FLOW.PUBLISH.TITLE",
    descKey: "LANDING.DLQ_FLOW.PUBLISH.DESC",
    details: [
      { icon: "pi pi-send", labelKey: "LANDING.DLQ_FLOW.PUBLISH.D1" },
      { icon: "pi pi-check", labelKey: "LANDING.DLQ_FLOW.PUBLISH.D2" },
      { icon: "pi pi-tag", labelKey: "LANDING.DLQ_FLOW.PUBLISH.D3" },
    ],
  },
  {
    id: "dlq-ingest",
    icon: "pi pi-server",
    titleKey: "LANDING.DLQ_FLOW.INGEST.TITLE",
    descKey: "LANDING.DLQ_FLOW.INGEST.DESC",
    details: [
      { icon: "pi pi-filter", labelKey: "LANDING.DLQ_FLOW.INGEST.D1" },
      { icon: "pi pi-inbox", labelKey: "LANDING.DLQ_FLOW.INGEST.D2" },
      { icon: "pi pi-ban", labelKey: "LANDING.DLQ_FLOW.INGEST.D3" },
    ],
  },
  {
    id: "postgres-dlq",
    icon: "pi pi-table",
    titleKey: "LANDING.DLQ_FLOW.POSTGRES.TITLE",
    descKey: "LANDING.DLQ_FLOW.POSTGRES.DESC",
    details: [
      { icon: "pi pi-list", labelKey: "LANDING.DLQ_FLOW.POSTGRES.D1" },
      { icon: "pi pi-clock", labelKey: "LANDING.DLQ_FLOW.POSTGRES.D2" },
      { icon: "pi pi-history", labelKey: "LANDING.DLQ_FLOW.POSTGRES.D3" },
    ],
  },
  {
    id: "ops-ui",
    icon: "pi pi-desktop",
    titleKey: "LANDING.DLQ_FLOW.OPS_UI.TITLE",
    descKey: "LANDING.DLQ_FLOW.OPS_UI.DESC",
    details: [
      { icon: "pi pi-filter", labelKey: "LANDING.DLQ_FLOW.OPS_UI.D1" },
      { icon: "pi pi-replay", labelKey: "LANDING.DLQ_FLOW.OPS_UI.D2" },
      { icon: "pi pi-shield", labelKey: "LANDING.DLQ_FLOW.OPS_UI.D3" },
    ],
  },
];
