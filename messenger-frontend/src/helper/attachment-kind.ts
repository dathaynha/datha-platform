/**
 * What an attachment is, from its filename.
 *
 * messenger-service stores the filename and nothing else — no MIME type — so
 * the extension is all there is to go on. That is also why the message body
 * carries the filename: it lets a recipient render the bubble without a
 * metadata round trip that file-service would refuse them anyway.
 */

/** Raster formats a browser renders in an `<img>`, plus SVG. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/**
 * Whether this attachment should be shown rather than listed.
 *
 * SVG is included: an `<img>` never runs script from its source, so the same
 * rule chatbot-frontend uses (`attachmentKindFromMimeAndName`) applies here.
 */
export function isImageAttachment(name: string): boolean {
  return IMAGE_EXTENSIONS.test(name.trim());
}
