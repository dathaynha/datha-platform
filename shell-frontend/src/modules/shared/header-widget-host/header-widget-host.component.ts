import { NgComponentOutlet } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  InjectionToken,
  OnInit,
  inject,
  signal,
  type Type,
} from "@angular/core";
import { loadRemoteModule } from "@angular-architects/module-federation";
import type { HeaderWidgetDescriptor } from "@models/index";
import { environment } from "src/environments/environment";

export type HeaderWidgetModuleLoader = (
  descriptor: HeaderWidgetDescriptor,
) => Promise<unknown>;

/** Indirection over `loadRemoteModule` so the degradation path is testable. */
export const HEADER_WIDGET_MODULE_LOADER =
  new InjectionToken<HeaderWidgetModuleLoader>("HEADER_WIDGET_MODULE_LOADER", {
    providedIn: "root",
    factory:
      () =>
      ({ remoteName, exposedModule }: HeaderWidgetDescriptor) =>
        loadRemoteModule({ type: "manifest", remoteName, exposedModule }),
  });

interface LoadedHeaderWidget {
  remoteName: string;
  component: Type<unknown>;
}

/**
 * Renders remote-owned header widgets declared in `environment.headerWidgets`.
 *
 * The shell owns the slot, the remote owns the content: no product code is
 * imported here, and a remote that is down leaves its slot empty rather than
 * breaking the header.
 */
@Component({
  selector: "shell-header-widget-host",
  imports: [NgComponentOutlet],
  template: `
    @for (widget of widgets(); track widget.remoteName) {
      <ng-container *ngComponentOutlet="widget.component" />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HeaderWidgetHostComponent implements OnInit {
  private readonly loadModule = inject(HEADER_WIDGET_MODULE_LOADER);

  readonly widgets = signal<LoadedHeaderWidget[]>([]);

  async ngOnInit(): Promise<void> {
    const descriptors: HeaderWidgetDescriptor[] = [
      ...((environment as { headerWidgets?: HeaderWidgetDescriptor[] })
        .headerWidgets ?? []),
    ].sort((a, b) => a.order - b.order);

    const loaded = await Promise.all(descriptors.map((d) => this.load(d)));
    this.widgets.set(
      loaded.filter((widget): widget is LoadedHeaderWidget => widget !== null),
    );
  }

  private async load(
    descriptor: HeaderWidgetDescriptor,
  ): Promise<LoadedHeaderWidget | null> {
    try {
      const module = await this.loadModule(descriptor);
      const component = (module as { default?: Type<unknown> }).default;
      if (!component) {
        console.warn(
          `[shell] header widget "${descriptor.remoteName}" exposes no default export; slot left empty`,
        );
        return null;
      }
      return { remoteName: descriptor.remoteName, component };
    } catch (error) {
      // A stopped or broken remote must never take the header down with it.
      console.warn(
        `[shell] header widget "${descriptor.remoteName}" failed to load; slot left empty`,
        error,
      );
      return null;
    }
  }
}
