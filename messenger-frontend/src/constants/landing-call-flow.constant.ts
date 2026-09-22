import type { LandingCallFlowNode } from "@models/home-page.model";

/** WebRTC 1:1 call setup, hand-built rather than delegated to an SFU. */
export const LANDING_CALL_FLOW_NODES: readonly LandingCallFlowNode[] = [
  {
    id: "credentials",
    icon: "pi pi-key",
    titleKey: "LANDING.CALL_FLOW.CREDENTIALS.TITLE",
    descKey: "LANDING.CALL_FLOW.CREDENTIALS.DESC",
    details: [
      { icon: "pi pi-clock", labelKey: "LANDING.CALL_FLOW.CREDENTIALS.D1" },
      { icon: "pi pi-lock", labelKey: "LANDING.CALL_FLOW.CREDENTIALS.D2" },
      { icon: "pi pi-eye-slash", labelKey: "LANDING.CALL_FLOW.CREDENTIALS.D3" },
    ],
  },
  {
    id: "offer",
    icon: "pi pi-video",
    titleKey: "LANDING.CALL_FLOW.OFFER.TITLE",
    descKey: "LANDING.CALL_FLOW.OFFER.DESC",
    details: [
      { icon: "pi pi-sync", labelKey: "LANDING.CALL_FLOW.OFFER.D1" },
      { icon: "pi pi-arrows-h", labelKey: "LANDING.CALL_FLOW.OFFER.D2" },
      { icon: "pi pi-microphone", labelKey: "LANDING.CALL_FLOW.OFFER.D3" },
    ],
  },
  {
    id: "relay",
    icon: "pi pi-bolt",
    titleKey: "LANDING.CALL_FLOW.RELAY.TITLE",
    descKey: "LANDING.CALL_FLOW.RELAY.DESC",
    details: [
      { icon: "pi pi-id-card", labelKey: "LANDING.CALL_FLOW.RELAY.D1" },
      { icon: "pi pi-verified", labelKey: "LANDING.CALL_FLOW.RELAY.D2" },
      { icon: "pi pi-ban", labelKey: "LANDING.CALL_FLOW.RELAY.D3" },
    ],
  },
  {
    id: "ice",
    icon: "pi pi-sitemap",
    titleKey: "LANDING.CALL_FLOW.ICE.TITLE",
    descKey: "LANDING.CALL_FLOW.ICE.DESC",
    details: [
      { icon: "pi pi-forward", labelKey: "LANDING.CALL_FLOW.ICE.D1" },
      { icon: "pi pi-globe", labelKey: "LANDING.CALL_FLOW.ICE.D2" },
      { icon: "pi pi-check", labelKey: "LANDING.CALL_FLOW.ICE.D3" },
    ],
  },
  {
    id: "media",
    icon: "pi pi-lock",
    titleKey: "LANDING.CALL_FLOW.MEDIA.TITLE",
    descKey: "LANDING.CALL_FLOW.MEDIA.DESC",
    details: [
      { icon: "pi pi-shield", labelKey: "LANDING.CALL_FLOW.MEDIA.D1" },
      { icon: "pi pi-users", labelKey: "LANDING.CALL_FLOW.MEDIA.D2" },
      { icon: "pi pi-chart-line", labelKey: "LANDING.CALL_FLOW.MEDIA.D3" },
    ],
  },
  {
    id: "turn",
    icon: "pi pi-directions",
    titleKey: "LANDING.CALL_FLOW.TURN.TITLE",
    descKey: "LANDING.CALL_FLOW.TURN.DESC",
    details: [
      { icon: "pi pi-building", labelKey: "LANDING.CALL_FLOW.TURN.D1" },
      { icon: "pi pi-eye-slash", labelKey: "LANDING.CALL_FLOW.TURN.D2" },
      { icon: "pi pi-percentage", labelKey: "LANDING.CALL_FLOW.TURN.D3" },
    ],
  },
];
