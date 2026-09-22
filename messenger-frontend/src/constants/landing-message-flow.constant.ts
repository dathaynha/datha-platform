import type { LandingMessageFlowNode } from "@models/home-page.model";

/** Send → store → fan out → receive; order matches the vertical diagram. */
export const LANDING_MESSAGE_FLOW_NODES: readonly LandingMessageFlowNode[] = [
  {
    id: "composer",
    icon: "pi pi-pencil",
    titleKey: "LANDING.MESSAGE_FLOW.COMPOSER.TITLE",
    descKey: "LANDING.MESSAGE_FLOW.COMPOSER.DESC",
    details: [
      { icon: "pi pi-send", labelKey: "LANDING.MESSAGE_FLOW.COMPOSER.D1" },
      { icon: "pi pi-replay", labelKey: "LANDING.MESSAGE_FLOW.COMPOSER.D2" },
      { icon: "pi pi-ban", labelKey: "LANDING.MESSAGE_FLOW.COMPOSER.D3" },
    ],
  },
  {
    id: "messenger-service",
    icon: "pi pi-server",
    titleKey: "LANDING.MESSAGE_FLOW.SERVICE.TITLE",
    descKey: "LANDING.MESSAGE_FLOW.SERVICE.DESC",
    details: [
      { icon: "pi pi-shield", labelKey: "LANDING.MESSAGE_FLOW.SERVICE.D1" },
      { icon: "pi pi-key", labelKey: "LANDING.MESSAGE_FLOW.SERVICE.D2" },
      { icon: "pi pi-clone", labelKey: "LANDING.MESSAGE_FLOW.SERVICE.D3" },
    ],
  },
  {
    id: "postgres",
    icon: "pi pi-table",
    titleKey: "LANDING.MESSAGE_FLOW.POSTGRES.TITLE",
    descKey: "LANDING.MESSAGE_FLOW.POSTGRES.DESC",
    details: [
      { icon: "pi pi-history", labelKey: "LANDING.MESSAGE_FLOW.POSTGRES.D1" },
      { icon: "pi pi-check", labelKey: "LANDING.MESSAGE_FLOW.POSTGRES.D2" },
      { icon: "pi pi-search", labelKey: "LANDING.MESSAGE_FLOW.POSTGRES.D3" },
    ],
  },
  {
    id: "nats",
    icon: "pi pi-share-alt",
    titleKey: "LANDING.MESSAGE_FLOW.NATS.TITLE",
    descKey: "LANDING.MESSAGE_FLOW.NATS.DESC",
    details: [
      { icon: "pi pi-inbox", labelKey: "LANDING.MESSAGE_FLOW.NATS.D1" },
      { icon: "pi pi-bolt", labelKey: "LANDING.MESSAGE_FLOW.NATS.D2" },
      { icon: "pi pi-ban", labelKey: "LANDING.MESSAGE_FLOW.NATS.D3" },
    ],
  },
  {
    id: "realtime-service",
    icon: "pi pi-bolt",
    titleKey: "LANDING.MESSAGE_FLOW.REALTIME.TITLE",
    descKey: "LANDING.MESSAGE_FLOW.REALTIME.DESC",
    details: [
      { icon: "pi pi-sitemap", labelKey: "LANDING.MESSAGE_FLOW.REALTIME.D1" },
      { icon: "pi pi-users", labelKey: "LANDING.MESSAGE_FLOW.REALTIME.D2" },
      { icon: "pi pi-server", labelKey: "LANDING.MESSAGE_FLOW.REALTIME.D3" },
    ],
  },
  {
    id: "recipient",
    icon: "pi pi-comments",
    titleKey: "LANDING.MESSAGE_FLOW.RECIPIENT.TITLE",
    descKey: "LANDING.MESSAGE_FLOW.RECIPIENT.DESC",
    details: [
      { icon: "pi pi-bell", labelKey: "LANDING.MESSAGE_FLOW.RECIPIENT.D1" },
      { icon: "pi pi-sync", labelKey: "LANDING.MESSAGE_FLOW.RECIPIENT.D2" },
      { icon: "pi pi-eye", labelKey: "LANDING.MESSAGE_FLOW.RECIPIENT.D3" },
    ],
  },
];
