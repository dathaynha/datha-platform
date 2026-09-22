export type AttachmentKind =
  "image" | "pdf" | "video" | "audio" | "doc" | "other";

export function attachmentKind(
  mime: string | null | undefined,
): AttachmentKind {
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  if (m.startsWith("image/")) {
    return "image";
  }
  if (m === "application/pdf") {
    return "pdf";
  }
  if (m.startsWith("video/")) {
    return "video";
  }
  if (m.startsWith("audio/")) {
    return "audio";
  }
  if (
    m === "application/msword" ||
    m.includes("wordprocessingml") ||
    m === "application/rtf"
  ) {
    return "doc";
  }
  return "other";
}

/** Prefer MIME; when unknown/generic (e.g. octet-stream), infer from filename for previews/icons. */
export function attachmentKindFromMimeAndName(
  mime: string | null | undefined,
  fileName: string | null | undefined,
): AttachmentKind {
  const fromMime = attachmentKind(mime);
  if (fromMime !== "other") {
    return fromMime;
  }
  const base = (fileName ?? "").trim().toLowerCase();
  if (!base) {
    return "other";
  }
  if (base.endsWith(".pdf")) {
    return "pdf";
  }
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(base)) {
    return "image";
  }
  return "other";
}

export function attachmentIconClass(
  mime: string | null | undefined,
  fileName?: string | null | undefined,
): string {
  const kind =
    (fileName ?? "").trim() !== ""
      ? attachmentKindFromMimeAndName(mime, fileName)
      : attachmentKind(mime);
  switch (kind) {
    case "image":
      return "pi pi-image text-sky-300/90";
    case "pdf":
      return "pi pi-file-pdf text-red-300/90";
    case "video":
      return "pi pi-video text-violet-300/90";
    case "audio":
      return "pi pi-volume-up text-emerald-300/90";
    case "doc":
      return "pi pi-file-word text-blue-300/90";
    default:
      return "pi pi-file text-slate-200/90";
  }
}
