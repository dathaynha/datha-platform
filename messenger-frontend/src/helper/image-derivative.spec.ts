import { imageDerivative } from "./image-derivative";

/** A real PNG of the requested size, so the browser can actually decode it. */
async function pngFile(
  name: string,
  width: number,
  height: number,
): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  // Noise, so the encoder cannot compress it down to nothing — a flat fill
  // makes a 4000px PNG smaller than the "worth it" floor and the case under
  // test never happens.
  const image = context.createImageData(width, height);
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = (i * 7) % 255;
    image.data[i + 1] = (i * 13) % 255;
    image.data[i + 2] = (i * 29) % 255;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  return new File([blob!], name, { type: "image/png" });
}

describe("imageDerivative", () => {
  it("reports the original's size and downscales a large picture", async () => {
    const file = await pngFile("holiday.png", 2000, 1200);

    const result = await imageDerivative(file);

    expect(result).not.toBeNull();
    expect(result!.width).toBe(2000);
    expect(result!.height).toBe(1200);
    // The whole point: what the thread paints is smaller than what was sent.
    expect(result!.thumbnail).not.toBeNull();
    expect(result!.thumbnail!.size).toBeLessThan(file.size);
    expect(result!.thumbnail!.type).toBe("image/webp");
  });

  it("keeps the size but makes no copy of a small picture", async () => {
    const file = await pngFile("icon.png", 64, 64);

    const result = await imageDerivative(file);

    // A derivative here would cost an upload to save nothing.
    expect(result).toEqual({ thumbnail: null, width: 64, height: 64 });
  });

  it("returns null for something that is not an image", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "notes.png", {
      type: "image/png",
    });

    // The caller then uploads the original alone, as it always did.
    await expectAsync(imageDerivative(file)).toBeResolvedTo(null);
  });
});
