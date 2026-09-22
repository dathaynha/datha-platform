import type { Routes } from "@angular/router";

/**
 * The open conversation is a route param, so a thread is linkable and the
 * header popover can navigate straight into one. Both paths render the same
 * page: the list is always present, the thread appears beside it.
 */
export const CHATS_ROUTES: Routes = [
  {
    path: "",
    loadComponent: () =>
      import("./pages/list/chats-page.component").then(
        (m) => m.ChatsPageComponent,
      ),
    data: { title: "Chats" },
  },
  {
    // Declared before ":id" and two segments deep, so a draft can never be
    // mistaken for a conversation id. A draft is linkable and survives reload
    // because the person it is addressed to is in the URL, not in memory.
    path: "new/:ownerId",
    loadComponent: () =>
      import("./pages/list/chats-page.component").then(
        (m) => m.ChatsPageComponent,
      ),
    data: { title: "Chats" },
  },
  {
    path: ":id",
    loadComponent: () =>
      import("./pages/list/chats-page.component").then(
        (m) => m.ChatsPageComponent,
      ),
    data: { title: "Chats" },
  },
];
