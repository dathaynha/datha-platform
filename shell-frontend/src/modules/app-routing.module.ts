import { NgModule } from "@angular/core";
import { RouterModule, Routes } from "@angular/router";
import { loadRemoteModule } from "@angular-architects/module-federation";
import { AuthGuard, LoginPageGuard } from "@guards/index";
import { AuthenticatedLayoutComponent } from "./shared/authenticated-layout/authenticated-layout.component";
import { UnauthenticatedLayoutComponent } from "./shared/unauthenticated-layout/unauthenticated-layout.component";

const routes: Routes = [
  {
    path: "login",
    component: UnauthenticatedLayoutComponent,
    children: [
      {
        path: "",
        canActivate: [LoginPageGuard],
        loadComponent: () =>
          import("@modules/login-page/login-page.component").then(
            (m) => m.LoginPageComponent,
          ),
        data: { title: "Login" },
      },
    ],
  },
  {
    path: "",
    component: AuthenticatedLayoutComponent,
    canActivate: [AuthGuard],
    children: [
      {
        path: "",
        loadComponent: () =>
          import("@modules/home-page/home-page.component").then(
            (m) => m.HomePageComponent,
          ),
        data: { title: "Home" },
      },
      {
        path: "settings",
        loadComponent: () =>
          import("@modules/settings/settings-page/settings-page.component").then(
            (m) => m.SettingsPageComponent,
          ),
        data: { title: "Settings" },
      },
      {
        path: "settings/notifications",
        loadComponent: () =>
          import("@modules/settings/notification-preferences-page/notification-preferences-page.component").then(
            (m) => m.NotificationPreferencesPageComponent,
          ),
        data: { title: "Notification Settings" },
      },
      {
        path: "chatbot",
        canLoad: [AuthGuard],
        loadChildren: () =>
          loadRemoteModule({
            type: "manifest",
            remoteName: "chatbot",
            exposedModule: "./Module",
          }).then((m) => m.ChatbotRemoteEntryModule),
        data: { title: "Chatbot", remoteName: "chatbot" },
      },
      {
        path: "messenger",
        canLoad: [AuthGuard],
        loadChildren: () =>
          loadRemoteModule({
            type: "manifest",
            remoteName: "messenger",
            exposedModule: "./Module",
          }).then((m) => m.MessengerRemoteEntryModule),
        data: { title: "Messenger", remoteName: "messenger" },
      },
      {
        path: "event-store",
        canLoad: [AuthGuard],
        loadChildren: () =>
          loadRemoteModule({
            type: "manifest",
            remoteName: "event-store",
            exposedModule: "./Module",
          }).then((m) => m.EventStoreRemoteEntryModule),
        data: { title: "Event Store", remoteName: "event-store" },
      },
    ],
  },
  {
    path: "**",
    redirectTo: "/",
    pathMatch: "full",
  },
];

@NgModule({
  imports: [RouterModule.forRoot(routes, { onSameUrlNavigation: "reload" })],
  exports: [RouterModule],
})
export class AppRoutingModule {}
