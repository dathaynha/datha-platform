/** Compact DLQ datepicker panels (appendTo=body). Works in standalone + shell MF. */
const COMPACT_ZOOM = "0.86";

export function installDatepickerCompactStyles(document: Document): void {
  if (document.documentElement.dataset["esDatepickerCompact"] === "true") {
    return;
  }
  document.documentElement.dataset["esDatepickerCompact"] = "true";

  const apply = (panel: HTMLElement): void => {
    if (panel.dataset["esCompactApplied"] === "true") {
      return;
    }
    panel.dataset["esCompactApplied"] = "true";
    panel.style.setProperty("zoom", COMPACT_ZOOM);
    panel.classList.add("es-datepicker-panel");
  };

  document
    .querySelectorAll<HTMLElement>(".p-datepicker-panel")
    .forEach((panel) => apply(panel));

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) {
          return;
        }
        if (node.classList.contains("p-datepicker-panel")) {
          apply(node);
        }
        node
          .querySelectorAll<HTMLElement>(".p-datepicker-panel")
          .forEach((panel) => apply(panel));
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
}
