import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from "@angular/core";
import {
  LANDING_DLQ_FLOW_NODES,
  LANDING_INGEST_FLOW_NODES,
} from "@constants/index";
import type {
  LandingDlqFlowNode,
  LandingDlqFlowNodeId,
  LandingFlowMode,
  LandingIngestFlowNode,
  LandingIngestFlowNodeId,
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
  readonly ingestFlowNodes = LANDING_INGEST_FLOW_NODES;
  readonly dlqFlowNodes = LANDING_DLQ_FLOW_NODES;

  readonly activeFlowMode = signal<LandingFlowMode>("ingest");

  private readonly selectedIngestFlowId =
    signal<LandingIngestFlowNodeId | null>(null);
  private readonly selectedDlqFlowId = signal<LandingDlqFlowNodeId | null>(
    null,
  );

  readonly isIngestFlow = computed(() => this.activeFlowMode() === "ingest");
  readonly isDlqFlow = computed(() => this.activeFlowMode() === "dlq");

  readonly activeFlowSubtitleKey = computed(() =>
    this.isIngestFlow()
      ? "LANDING.INGEST_FLOW.SUBTITLE"
      : "LANDING.DLQ_FLOW.SUBTITLE",
  );

  readonly activeFlowDiagramAriaKey = computed(() =>
    this.isIngestFlow()
      ? "LANDING.INGEST_FLOW.DIAGRAM_ARIA"
      : "LANDING.DLQ_FLOW.DIAGRAM_ARIA",
  );

  readonly activeFlowPanel = computed(() =>
    this.isIngestFlow()
      ? this.selectedIngestFlowNode()
      : this.selectedDlqFlowNode(),
  );

  readonly activeFlowPanelEmptyKey = computed(() =>
    this.isIngestFlow()
      ? "LANDING.INGEST_FLOW.PANEL_EMPTY"
      : "LANDING.DLQ_FLOW.PANEL_EMPTY",
  );

  readonly activeFlowPanelKickerKey = computed(() =>
    this.isIngestFlow()
      ? "LANDING.INGEST_FLOW.PANEL_KICKER"
      : "LANDING.DLQ_FLOW.PANEL_KICKER",
  );

  readonly selectedIngestFlowNode = computed(() => {
    const id = this.selectedIngestFlowId();
    if (!id) {
      return null;
    }
    return this.ingestFlowNodes.find((n) => n.id === id) ?? null;
  });

  readonly selectedDlqFlowNode = computed(() => {
    const id = this.selectedDlqFlowId();
    if (!id) {
      return null;
    }
    return this.dlqFlowNodes.find((n) => n.id === id) ?? null;
  });

  readonly stackCardGroups: readonly LandingStackCardGroup[] = [
    {
      headingId: "landing-stack-client",
      titleKey: "LANDING.STACK_GROUP_CLIENT",
      gridClass: "landing-cards--4",
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
      gridClass: "landing-cards--3",
      cards: [
        {
          icon: "pi pi-sliders-h",
          title: "API Gateway (Go)",
          descKey: "LANDING.CARD_GATEWAY",
        },
        {
          icon: "pi pi-server",
          title: "event-store (Fastify)",
          descKey: "LANDING.CARD_EVENT_STORE",
        },
        {
          icon: "pi pi-sitemap",
          title: "platform-nats",
          descKey: "LANDING.CARD_PLATFORM_NATS",
        },
      ],
    },
    {
      headingId: "landing-stack-data",
      titleKey: "LANDING.STACK_GROUP_DATA",
      gridClass: "landing-cards--2",
      cards: [
        {
          icon: "pi pi-table",
          title: "PostgreSQL",
          descKey: "LANDING.CARD_POSTGRES",
        },
        {
          icon: "pi pi-share-alt",
          title: "NATS JetStream",
          descKey: "LANDING.CARD_NATS",
        },
      ],
    },
  ] as const;

  setFlowMode(mode: LandingFlowMode): void {
    if (this.activeFlowMode() === mode) {
      return;
    }
    this.activeFlowMode.set(mode);
    this.selectedIngestFlowId.set(null);
    this.selectedDlqFlowId.set(null);
  }

  getIngestFlowNode(id: LandingIngestFlowNodeId): LandingIngestFlowNode {
    const n = this.ingestFlowNodes.find((x) => x.id === id);
    if (!n) {
      throw new Error(`Unknown ingest flow node: ${id}`);
    }
    return n;
  }

  selectIngestFlowNode(id: LandingIngestFlowNodeId): void {
    this.selectedIngestFlowId.update((cur) => (cur === id ? null : id));
  }

  isIngestFlowSelected(id: LandingIngestFlowNodeId): boolean {
    return this.selectedIngestFlowId() === id;
  }

  getDlqFlowNode(id: LandingDlqFlowNodeId): LandingDlqFlowNode {
    const n = this.dlqFlowNodes.find((x) => x.id === id);
    if (!n) {
      throw new Error(`Unknown DLQ flow node: ${id}`);
    }
    return n;
  }

  selectDlqFlowNode(id: LandingDlqFlowNodeId): void {
    this.selectedDlqFlowId.update((cur) => (cur === id ? null : id));
  }

  isDlqFlowSelected(id: LandingDlqFlowNodeId): boolean {
    return this.selectedDlqFlowId() === id;
  }
}
