import type { LandingDeleteFlowNode } from "@models/home-page.model";

/** Conversation delete → NATS → orphan file cleanup (see platform chatbot-file-events). */
export const LANDING_DELETE_FLOW_NODES: readonly LandingDeleteFlowNode[] = [
  {
    id: "angular",
    icon: "pi pi-desktop",
    titleKey: "LANDING.DELETE_FLOW.ANGULAR.TITLE",
    descKey: "LANDING.DELETE_FLOW.ANGULAR.DESC",
    details: [
      { icon: "pi pi-trash", labelKey: "LANDING.DELETE_FLOW.ANGULAR.D1" },
      {
        icon: "pi pi-question-circle",
        labelKey: "LANDING.DELETE_FLOW.ANGULAR.D2",
      },
      { icon: "pi pi-arrows-h", labelKey: "LANDING.DELETE_FLOW.ANGULAR.D3" },
      { icon: "pi pi-check", labelKey: "LANDING.DELETE_FLOW.ANGULAR.D4" },
    ],
  },
  {
    id: "gateway",
    icon: "pi pi-sliders-h",
    titleKey: "LANDING.DELETE_FLOW.GATEWAY.TITLE",
    descKey: "LANDING.DELETE_FLOW.GATEWAY.DESC",
    details: [
      { icon: "pi pi-shield", labelKey: "LANDING.DELETE_FLOW.GATEWAY.D1" },
      { icon: "pi pi-user", labelKey: "LANDING.DELETE_FLOW.GATEWAY.D2" },
      { icon: "pi pi-share-alt", labelKey: "LANDING.DELETE_FLOW.GATEWAY.D3" },
    ],
  },
  {
    id: "fastapi",
    icon: "pi pi-server",
    titleKey: "LANDING.DELETE_FLOW.FASTAPI.TITLE",
    descKey: "LANDING.DELETE_FLOW.FASTAPI.DESC",
    details: [
      { icon: "pi pi-search", labelKey: "LANDING.DELETE_FLOW.FASTAPI.D1" },
      { icon: "pi pi-database", labelKey: "LANDING.DELETE_FLOW.FASTAPI.D2" },
      { icon: "pi pi-send", labelKey: "LANDING.DELETE_FLOW.FASTAPI.D3" },
      { icon: "pi pi-replay", labelKey: "LANDING.DELETE_FLOW.FASTAPI.D4" },
      {
        icon: "pi pi-check-circle",
        labelKey: "LANDING.DELETE_FLOW.FASTAPI.D5",
      },
    ],
  },
  {
    id: "postgres",
    icon: "pi pi-table",
    titleKey: "LANDING.DELETE_FLOW.POSTGRES.TITLE",
    descKey: "LANDING.DELETE_FLOW.POSTGRES.DESC",
    details: [
      { icon: "pi pi-link", labelKey: "LANDING.DELETE_FLOW.POSTGRES.D1" },
      { icon: "pi pi-trash", labelKey: "LANDING.DELETE_FLOW.POSTGRES.D2" },
      { icon: "pi pi-lock", labelKey: "LANDING.DELETE_FLOW.POSTGRES.D3" },
    ],
  },
  {
    id: "nats",
    icon: "pi pi-share-alt",
    titleKey: "LANDING.DELETE_FLOW.NATS.TITLE",
    descKey: "LANDING.DELETE_FLOW.NATS.DESC",
    details: [
      { icon: "pi pi-envelope", labelKey: "LANDING.DELETE_FLOW.NATS.D1" },
      { icon: "pi pi-list", labelKey: "LANDING.DELETE_FLOW.NATS.D2" },
      { icon: "pi pi-inbox", labelKey: "LANDING.DELETE_FLOW.NATS.D3" },
    ],
  },
  {
    id: "file-service",
    icon: "pi pi-file",
    titleKey: "LANDING.DELETE_FLOW.FILE_SERVICE.TITLE",
    descKey: "LANDING.DELETE_FLOW.FILE_SERVICE.DESC",
    details: [
      {
        icon: "pi pi-download",
        labelKey: "LANDING.DELETE_FLOW.FILE_SERVICE.D1",
      },
      { icon: "pi pi-shield", labelKey: "LANDING.DELETE_FLOW.FILE_SERVICE.D2" },
      { icon: "pi pi-table", labelKey: "LANDING.DELETE_FLOW.FILE_SERVICE.D3" },
      { icon: "pi pi-cloud", labelKey: "LANDING.DELETE_FLOW.FILE_SERVICE.D4" },
      { icon: "pi pi-replay", labelKey: "LANDING.DELETE_FLOW.FILE_SERVICE.D5" },
    ],
  },
  {
    id: "azure-blob",
    icon: "pi pi-cloud",
    titleKey: "LANDING.DELETE_FLOW.AZURE_BLOB.TITLE",
    descKey: "LANDING.DELETE_FLOW.AZURE_BLOB.DESC",
    details: [
      { icon: "pi pi-database", labelKey: "LANDING.DELETE_FLOW.AZURE_BLOB.D1" },
      { icon: "pi pi-trash", labelKey: "LANDING.DELETE_FLOW.AZURE_BLOB.D2" },
      { icon: "pi pi-lock", labelKey: "LANDING.DELETE_FLOW.AZURE_BLOB.D3" },
    ],
  },
  {
    id: "event-store",
    icon: "pi pi-history",
    titleKey: "LANDING.DELETE_FLOW.EVENT_STORE.TITLE",
    descKey: "LANDING.DELETE_FLOW.EVENT_STORE.DESC",
    details: [
      {
        icon: "pi pi-database",
        labelKey: "LANDING.DELETE_FLOW.EVENT_STORE.D1",
      },
      { icon: "pi pi-eye", labelKey: "LANDING.DELETE_FLOW.EVENT_STORE.D2" },
      { icon: "pi pi-ban", labelKey: "LANDING.DELETE_FLOW.EVENT_STORE.D3" },
    ],
  },
] as const;
