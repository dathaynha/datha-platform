import { Routes } from "@angular/router";

export const DLQ_ROUTES: Routes = [
  {
    path: "",
    loadComponent: () =>
      import("./pages/list/dlq-page.component").then((m) => m.DlqPageComponent),
    data: { title: "DLQ" },
  },
  {
    path: ":id",
    loadComponent: () =>
      import("./pages/detail/dlq-detail-page.component").then(
        (m) => m.DlqDetailPageComponent,
      ),
    data: { title: "DLQ record" },
  },
];
