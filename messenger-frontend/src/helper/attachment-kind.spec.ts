import { isImageAttachment } from "./attachment-kind";

describe("isImageAttachment", () => {
  it("recognises the formats a browser can paint", () => {
    for (const name of [
      "holiday.png",
      "cat.GIF",
      "shot.jpeg",
      "photo.jpg",
      "sticker.webp",
      "icon.svg",
      "scan.avif",
      "old.bmp",
    ]) {
      expect(isImageAttachment(name)).withContext(name).toBeTrue();
    }
  });

  it("leaves everything else as a file", () => {
    for (const name of [
      "spec.pdf",
      "notes.txt",
      "archive.zip",
      "clip.mp4",
      "pngs",
      "image.png.zip",
      "",
    ]) {
      expect(isImageAttachment(name)).withContext(name).toBeFalse();
    }
  });
});
