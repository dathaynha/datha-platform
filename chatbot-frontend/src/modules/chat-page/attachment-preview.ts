let pdfWorkerSrcConfigured = false;

function configurePdfWorker(pdfjs: typeof import("pdfjs-dist")): void {
  if (pdfWorkerSrcConfigured) {
    return;
  }
  pdfWorkerSrcConfigured = true;
  // Served via angular.json assets → `/assets/pdfjs/` (works with `ng serve`, unlike `/pdfjs`).
  const workerHref = new URL(
    "assets/pdfjs/pdf.worker.min.mjs",
    document.baseURI,
  ).href;
  pdfjs.GlobalWorkerOptions.workerSrc = workerHref;
}

async function renderPdfBytesToDataUrl(
  data: ArrayBuffer,
  maxSidePx: number,
): Promise<string | null> {
  try {
    const pdfjs = await import("pdfjs-dist");
    configurePdfWorker(pdfjs);
    // Copy so pdf.js/WebAssembly never sees a detached HttpClient ArrayBuffer.
    const bytes = data.byteLength === 0 ? data : data.slice(0);
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = maxSidePx / Math.max(baseViewport.width, baseViewport.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return null;
  }
}

/** Renders the first PDF page from raw bytes (e.g. fetch → arrayBuffer). */
export async function renderPdfFirstPageDataUrlFromArrayBuffer(
  data: ArrayBuffer,
  maxSidePx = 168,
): Promise<string | null> {
  return renderPdfBytesToDataUrl(data, maxSidePx);
}

/** Returns a revocable object URL, or null when the file is not an image. */
export function createImagePreviewObjectUrl(file: File): string | null {
  const t = (file.type ?? "").toLowerCase().split(";")[0].trim();
  if (!t.startsWith("image/")) {
    return null;
  }
  return URL.createObjectURL(file);
}

/** Renders the first PDF page to a JPEG data URL (no revoke needed). */
export async function renderPdfFirstPageDataUrl(
  file: File,
  maxSidePx = 168,
): Promise<string | null> {
  const mime = (file.type ?? "").toLowerCase().split(";")[0].trim();
  const name = file.name.trim().toLowerCase();
  const looksPdf =
    mime === "application/pdf" ||
    ((mime === "" || mime === "application/octet-stream") &&
      name.endsWith(".pdf"));
  if (!looksPdf) {
    return null;
  }
  try {
    const data = await file.arrayBuffer();
    return await renderPdfBytesToDataUrl(data, maxSidePx);
  } catch {
    return null;
  }
}
