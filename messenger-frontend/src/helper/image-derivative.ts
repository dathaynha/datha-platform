/**
 * A downscaled copy of an image, made in the browser before upload.
 *
 * The uploading client is the only party that ever holds the bytes: file-service
 * neither proxies blobs nor interprets their content (both are explicit "does
 * not" rows in its architecture), and messenger-service never sees them either.
 * So the thumbnail a thread paints, and the dimensions a bubble reserves space
 * with, are produced here or not at all.
 */

/** Longest edge of the derivative. A thread never paints wider than ~288 CSS px. */
const MAX_EDGE = 1024;
/** Below this, a derivative would cost a request to save nothing. */
const MIN_ORIGINAL_BYTES = 120 * 1024;

export interface ImageDerivative {
  /** The downscaled file, or null when the original is already small enough. */
  thumbnail: File | null;
  /** The original's pixel size. */
  width: number;
  height: number;
}

function targetSize(width: number, height: number): [number, number] {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return [width, height];
  const scale = MAX_EDGE / longest;
  return [Math.round(width * scale), Math.round(height * scale)];
}

async function encode(
  canvas: HTMLCanvasElement,
  name: string,
): Promise<File | null> {
  // WebP at every browser this app supports, which is the whole point: it is
  // roughly a third of the JPEG bytes at the same quality.
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.82),
  );
  if (!blob) return null;
  return new File([blob], `${name}.thumb.webp`, { type: "image/webp" });
}

/**
 * Decodes an image and returns its size plus a downscaled copy.
 *
 * Returns null when the file cannot be decoded — a `.png` that is not one, or
 * an SVG, which has no natural pixel size worth reserving. The caller then
 * uploads the original alone, exactly as it did before this existed.
 */
export async function imageDerivative(
  file: File,
): Promise<ImageDerivative | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  const { width, height } = bitmap;
  try {
    if (width === 0 || height === 0) return null;

    const [targetWidth, targetHeight] = targetSize(width, height);
    const worthIt =
      file.size >= MIN_ORIGINAL_BYTES &&
      (targetWidth < width || targetHeight < height);
    if (!worthIt) return { thumbnail: null, width, height };

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) return { thumbnail: null, width, height };
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    const thumbnail = await encode(canvas, file.name);
    // A derivative bigger than what it replaces is not a derivative.
    return {
      thumbnail: thumbnail && thumbnail.size < file.size ? thumbnail : null,
      width,
      height,
    };
  } finally {
    bitmap.close();
  }
}
