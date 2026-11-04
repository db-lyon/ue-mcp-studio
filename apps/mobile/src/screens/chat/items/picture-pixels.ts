/**
 * A loaded picture's pixels on the phone, where no canvas reads an image: the
 * data URI's PNG decoded. Anything else is null, so a picture this cannot read
 * is shown rather than hidden.
 */
import { decodePng, fromBase64 } from "./png";

export async function picturePixels(uri: string): Promise<Uint8ClampedArray | null> {
  const m = /^data:image\/png;base64,(.*)$/.exec(uri);
  return m ? decodePng(fromBase64(m[1])) : null;
}
