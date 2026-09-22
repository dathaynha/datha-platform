import { NgModule } from "@angular/core";
import { RouterModule, Routes } from "@angular/router";
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
        path: "chat",
        loadComponent: () =>
          import("@modules/chat-page/chat-page.component").then(
            ({ ChatPageComponent }) => ChatPageComponent,
          ),
        data: { title: "Chat" },
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
