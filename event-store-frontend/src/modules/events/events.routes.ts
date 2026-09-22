import { Routes } from "@angular/router";

export const EVENTS_ROUTES: Routes = [
  {
    path: "",
    loadComponent: () =>
      import("./pages/list/events-page.component").then(
        (m) => m.EventsPageComponent,
      ),
    data: { title: "Events" },
  },
  {
    path: ":id",
    loadComponent: () =>
      import("./pages/detail/events-detail-page.component").then(
        (m) => m.EventsDetailPageComponent,
      ),
    data: { title: "Event detail" },
  },
];
