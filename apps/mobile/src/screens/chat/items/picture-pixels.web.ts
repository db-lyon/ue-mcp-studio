/**
 * A loaded picture's pixels in a browser (the visual QA page and tests), read
 * through a small canvas as the web client reads them; null where the browser
 * will not give them.
 */
export async function picturePixels(uri: string): Promise<Uint8ClampedArray | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const img = new Image();
  const loaded = new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
  img.src = uri;
  if (!(await loaded)) return null;
  try {
    const n = 64;
    const canvas = document.createElement("canvas");
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, n, n);
    return ctx.getImageData(0, 0, n, n).data;
  } catch {
    return null;
  }
}
