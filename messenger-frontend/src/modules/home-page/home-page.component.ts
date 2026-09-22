import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from "@angular/core";
import {
  LANDING_CALL_FLOW_NODES,
  LANDING_MESSAGE_FLOW_NODES,
} from "@constants/index";
import type {
  LandingCallFlowNode,
  LandingCallFlowNodeId,
  LandingFlowMode,
  LandingMessageFlowNode,
  LandingMessageFlowNodeId,
  LandingFlowLink,
  LandingStackCardGroup,
} from "@models/home-page.model";
import { TranslateModule } from "@ngx-translate/core";
import { CardModule } from "primeng/card";

@Component({
  selector: "app-home-page",
  imports: [TranslateModule, CardModule],
  templateUrl: "./home-page.component.html",
  styleUrls: ["./home-page.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden",
  },
})
export class HomePageComponent {
  readonly messageFlowNodes = LANDING_MESSAGE_FLOW_NODES;
  readonly callFlowNodes = LANDING_CALL_FLOW_NODES;

  readonly activeFlowMode = signal<LandingFlowMode>("message");

  private readonly selectedMessageFlowId =
    signal<LandingMessageFlowNodeId | null>(null);
  private readonly selectedCallFlowId = signal<LandingCallFlowNodeId | null>(
    null,
  );

  readonly isMessageFlow = computed(() => this.activeFlowMode() === "message");
  readonly isCallFlow = computed(() => this.activeFlowMode() === "call");

  readonly activeFlowSubtitleKey = computed(() =>
    this.isMessageFlow()
      ? "LANDING.MESSAGE_FLOW.SUBTITLE"
      : "LANDING.CALL_FLOW.SUBTITLE",
  );

  readonly activeFlowDiagramAriaKey = computed(() =>
    this.isMessageFlow()
      ? "LANDING.MESSAGE_FLOW.DIAGRAM_ARIA"
      : "LANDING.CALL_FLOW.DIAGRAM_ARIA",
  );

  readonly activeFlowPanel = computed(() =>
    this.isMessageFlow()
      ? this.selectedMessageFlowNode()
      : this.selectedCallFlowNode(),
  );

  readonly activeFlowPanelEmptyKey = computed(() =>
    this.isMessageFlow()
      ? "LANDING.MESSAGE_FLOW.PANEL_EMPTY"
      : "LANDING.CALL_FLOW.PANEL_EMPTY",
  );

  readonly activeFlowPanelKickerKey = computed(() =>
    this.isMessageFlow()
      ? "LANDING.MESSAGE_FLOW.PANEL_KICKER"
      : "LANDING.CALL_FLOW.PANEL_KICKER",
  );

  readonly selectedMessageFlowNode = computed(() => {
    const id = this.selectedMessageFlowId();
    if (!id) {
      return null;
    }
    return this.messageFlowNodes.find((n) => n.id === id) ?? null;
  });

  readonly selectedCallFlowNode = computed(() => {
    const id = this.selectedCallFlowId();
    if (!id) {
      return null;
    }
    return this.callFlowNodes.find((n) => n.id === id) ?? null;
  });

  /**
   * Connector labels between the diagram's nodes, in order.
   *
   * `code: true` marks a label that is a literal — an HTTP path, a NATS
   * subject, a WebRTC method. Those render verbatim; the prose ones take the
   * uppercase treatment. One list rather than an index-keyed ternary in the
   * template *and* a second index-keyed class binding beside it, which would
   * be the same knowledge written twice.
   */
  readonly messageFlowLinks: readonly LandingFlowLink[] = [
    { key: "LANDING.MESSAGE_FLOW.LINK_POST", code: true },
    { key: "LANDING.MESSAGE_FLOW.LINK_PERSIST", code: false },
    { key: "LANDING.MESSAGE_FLOW.LINK_PUBLISH", code: false },
    { key: "LANDING.MESSAGE_FLOW.LINK_FANOUT", code: true },
    { key: "LANDING.MESSAGE_FLOW.LINK_SOCKET", code: false },
  ];

  readonly callFlowLinks: readonly LandingFlowLink[] = [
    { key: "LANDING.CALL_FLOW.LINK_OFFER", code: true },
    { key: "LANDING.CALL_FLOW.LINK_RELAY", code: false },
    { key: "LANDING.CALL_FLOW.LINK_CANDIDATES", code: false },
    { key: "LANDING.CALL_FLOW.LINK_CONNECTED", code: false },
    { key: "LANDING.CALL_FLOW.LINK_FALLBACK", code: false },
  ];

  readonly stackCardGroups: readonly LandingStackCardGroup[] = [
    {
      headingId: "landing-stack-client",
      titleKey: "LANDING.STACK_GROUP_CLIENT",
      gridClass: "landing-cards--three",
      cards: [
        {
          icon: "pi pi-code",
          title: "Angular 21 + Module Federation",
          descKey: "LANDING.CARD_ANGULAR",
        },
        {
          icon: "pi pi-window-maximize",
          title: "Shell header widget",
          descKey: "LANDING.CARD_HEADER_WIDGET",
        },
        {
          icon: "pi pi-video",
          title: "WebRTC by hand",
          descKey: "LANDING.CARD_WEBRTC",
        },
        {
          icon: "pi pi-sitemap",
          title: "Peer-to-peer mesh",
          descKey: "LANDING.CARD_MESH",
        },
        {
          icon: "pi pi-shield",
          title: "OAuth2 / OIDC",
          descKey: "LANDING.CARD_AUTH",
        },
      ],
    },
    {
      headingId: "landing-stack-realtime",
      titleKey: "LANDING.STACK_GROUP_REALTIME",
      gridClass: "landing-cards--four",
      cards: [
        {
          icon: "pi pi-bolt",
          title: "realtime-service (Go)",
          descKey: "LANDING.CARD_REALTIME",
        },
        {
          icon: "pi pi-users",
          title: "The call room",
          descKey: "LANDING.CARD_ROOM",
        },
        {
          icon: "pi pi-share-alt",
          title: "NATS core fan-out",
          descKey: "LANDING.CARD_NATS_CORE",
        },
        {
          icon: "pi pi-directions",
          title: "coturn (STUN / TURN)",
          descKey: "LANDING.CARD_COTURN",
        },
      ],
    },
    {
      headingId: "landing-stack-data",
      titleKey: "LANDING.STACK_GROUP_DATA",
      gridClass: "landing-cards--four",
      cards: [
        {
          icon: "pi pi-server",
          title: "messenger-service (Fastify)",
          descKey: "LANDING.CARD_MESSENGER_SERVICE",
        },
        {
          icon: "pi pi-users",
          title: "accounts-service",
          descKey: "LANDING.CARD_ACCOUNTS",
        },
        {
          icon: "pi pi-table",
          title: "PostgreSQL",
          descKey: "LANDING.CARD_POSTGRES",
        },
        {
          icon: "pi pi-inbox",
          title: "NATS JetStream",
          descKey: "LANDING.CARD_JETSTREAM",
        },
      ],
    },
  ] as const;

  setFlowMode(mode: LandingFlowMode): void {
    if (this.activeFlowMode() === mode) {
      return;
    }
    this.activeFlowMode.set(mode);
    this.selectedMessageFlowId.set(null);
    this.selectedCallFlowId.set(null);
  }

  getMessageFlowNode(id: LandingMessageFlowNodeId): LandingMessageFlowNode {
    const n = this.messageFlowNodes.find((x) => x.id === id);
    if (!n) {
      throw new Error(`Unknown message flow node: ${id}`);
    }
    return n;
  }

  selectMessageFlowNode(id: LandingMessageFlowNodeId): void {
    this.selectedMessageFlowId.update((cur) => (cur === id ? null : id));
  }

  isMessageFlowSelected(id: LandingMessageFlowNodeId): boolean {
    return this.selectedMessageFlowId() === id;
  }

  getCallFlowNode(id: LandingCallFlowNodeId): LandingCallFlowNode {
    const n = this.callFlowNodes.find((x) => x.id === id);
    if (!n) {
      throw new Error(`Unknown call flow node: ${id}`);
    }
    return n;
  }

  selectCallFlowNode(id: LandingCallFlowNodeId): void {
    this.selectedCallFlowId.update((cur) => (cur === id ? null : id));
  }

  isCallFlowSelected(id: LandingCallFlowNodeId): boolean {
    return this.selectedCallFlowId() === id;
  }
}
