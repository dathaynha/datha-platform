import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from "@angular/core";
import type {
  LandingDeleteFlowNode,
  LandingDeleteFlowNodeId,
  LandingFlowMode,
  LandingFlowNode,
  LandingFlowNodeId,
  LandingStackCardGroup,
} from "@models/home-page.model";
import {
  LANDING_DELETE_FLOW_NODES,
  LANDING_FLOW_NODES,
} from "@constants/index";
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
  readonly flowNodes: readonly LandingFlowNode[] = LANDING_FLOW_NODES;
  readonly deleteFlowNodes: readonly LandingDeleteFlowNode[] =
    LANDING_DELETE_FLOW_NODES;

  readonly activeFlowMode = signal<LandingFlowMode>("message");

  private readonly selectedFlowId = signal<LandingFlowNodeId | null>(null);
  private readonly selectedDeleteFlowId =
    signal<LandingDeleteFlowNodeId | null>(null);

  readonly isMessageFlow = computed(() => this.activeFlowMode() === "message");
  readonly isDeleteFlow = computed(() => this.activeFlowMode() === "delete");

  readonly activeFlowSubtitleKey = computed(() =>
    this.isMessageFlow()
      ? "LANDING.FLOW.SUBTITLE"
      : "LANDING.DELETE_FLOW.SUBTITLE",
  );

  readonly activeFlowDiagramAriaKey = computed(() =>
    this.isMessageFlow()
      ? "LANDING.FLOW.DIAGRAM_ARIA"
      : "LANDING.DELETE_FLOW.DIAGRAM_ARIA",
  );

  readonly activeFlowPanel = computed(() =>
    this.isMessageFlow()
      ? this.selectedFlowNode()
      : this.selectedDeleteFlowNode(),
  );

  readonly activeFlowPanelEmptyKey = computed(() =>
    this.isMessageFlow()
      ? "LANDING.FLOW.PANEL_EMPTY"
      : "LANDING.DELETE_FLOW.PANEL_EMPTY",
  );

  readonly activeFlowPanelKickerKey = computed(() =>
    this.isMessageFlow()
      ? "LANDING.FLOW.PANEL_KICKER"
      : "LANDING.DELETE_FLOW.PANEL_KICKER",
  );

  readonly selectedFlowNode = computed(() => {
    const id = this.selectedFlowId();
    if (!id) {
      return null;
    }
    return this.flowNodes.find((n) => n.id === id) ?? null;
  });

  readonly selectedDeleteFlowNode = computed(() => {
    const id = this.selectedDeleteFlowId();
    if (!id) {
      return null;
    }
    return this.deleteFlowNodes.find((n) => n.id === id) ?? null;
  });

  readonly stackCardGroups: readonly LandingStackCardGroup[] = [
    {
      headingId: "landing-stack-client",
      titleKey: "LANDING.STACK_GROUP_CLIENT",
      gridClass: "landing-cards--four",
      cards: [
        {
          icon: "pi pi-code",
          title: "Angular 21 + TypeScript",
          descKey: "LANDING.CARD_ANGULAR",
        },
        {
          icon: "pi pi-objects-column",
          title: "PrimeNG + Aura",
          descKey: "LANDING.CARD_PRIMENG",
        },
        {
          icon: "pi pi-globe",
          title: "Translations (@ngx-translate)",
          descKey: "LANDING.CARD_I18N",
        },
        {
          icon: "pi pi-shield",
          title: "OAuth2 / OIDC",
          descKey: "LANDING.CARD_AUTH",
        },
      ],
    },
    {
      headingId: "landing-stack-services",
      titleKey: "LANDING.STACK_GROUP_SERVICES",
      gridClass: "landing-cards--four",
      cards: [
        {
          icon: "pi pi-sliders-h",
          title: "API Gateway (Go)",
          descKey: "LANDING.CARD_GATEWAY",
        },
        {
          icon: "pi pi-server",
          title: "FastAPI (chatbot-service)",
          descKey: "LANDING.CARD_API",
        },
        {
          icon: "pi pi-file",
          title: "File Service (Fastify)",
          descKey: "LANDING.CARD_FILE_SERVICE",
        },
        {
          icon: "pi pi-history",
          title: "Event Store",
          descKey: "LANDING.CARD_EVENT_STORE",
        },
      ],
    },
    {
      headingId: "landing-stack-data",
      titleKey: "LANDING.STACK_GROUP_DATA",
      gridClass: "landing-cards--five",
      cards: [
        {
          icon: "pi pi-table",
          title: "PostgreSQL",
          descKey: "LANDING.CARD_POSTGRES",
        },
        {
          icon: "pi pi-inbox",
          title: "Redis",
          descKey: "LANDING.CARD_REDIS",
        },
        {
          icon: "pi pi-cloud",
          title: "Azure Blob Storage",
          descKey: "LANDING.CARD_AZURE_BLOB",
        },
        {
          icon: "pi pi-share-alt",
          title: "NATS JetStream",
          descKey: "LANDING.CARD_NATS",
        },
        {
          icon: "pi pi-sparkles",
          title: "Google Gemini",
          descKey: "LANDING.CARD_GEMINI",
        },
      ],
    },
  ] as const;

  setFlowMode(mode: LandingFlowMode): void {
    if (this.activeFlowMode() === mode) {
      return;
    }
    this.activeFlowMode.set(mode);
    this.selectedFlowId.set(null);
    this.selectedDeleteFlowId.set(null);
  }

  getFlowNode(id: LandingFlowNodeId): LandingFlowNode {
    const n = this.flowNodes.find((x) => x.id === id);
    if (!n) {
      throw new Error(`Unknown flow node: ${id}`);
    }
    return n;
  }

  selectFlowNode(id: LandingFlowNodeId): void {
    this.selectedFlowId.update((cur) => (cur === id ? null : id));
  }

  isFlowSelected(id: LandingFlowNodeId): boolean {
    return this.selectedFlowId() === id;
  }

  getDeleteFlowNode(id: LandingDeleteFlowNodeId): LandingDeleteFlowNode {
    const n = this.deleteFlowNodes.find((x) => x.id === id);
    if (!n) {
      throw new Error(`Unknown delete flow node: ${id}`);
    }
    return n;
  }

  selectDeleteFlowNode(id: LandingDeleteFlowNodeId): void {
    this.selectedDeleteFlowId.update((cur) => (cur === id ? null : id));
  }

  isDeleteFlowSelected(id: LandingDeleteFlowNodeId): boolean {
    return this.selectedDeleteFlowId() === id;
  }
}
