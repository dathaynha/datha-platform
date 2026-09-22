import { HeaderWidgetComponent } from "./modules/header-widget/header-widget.component";

/**
 * Module Federation "./HeaderWidget" expose — the messenger icon the shell
 * renders in its top header (see shell `environment.headerWidgets`).
 *
 * Default-exported on purpose: that is the shell's contract for a widget slot,
 * so onboarding one stays config-only with no class name to keep in sync.
 */
export default HeaderWidgetComponent;
