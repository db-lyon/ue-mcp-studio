/**
 * A picture the computer serves, kept as a file in the app's cache for an Image
 * to draw: its bytes go from the relay to the file as they arrive, never through
 * one string. A data URI of a 12 MB capture was a 16 MB string built in Hermes
 * and handed to the Image whole.
 */
import { Directory, File, FileMode, Paths } from "expo-file-system";

let folder: Directory | null = null;
let count = 0;

/** This run's folder: the files an earlier run kept are gone, so the cache never grows past one run's pictures. */
function pictures(): Directory {
  if (!folder) {
    folder = new Directory(Paths.cache, "studio-pictures");
    try {
      if (folder.exists) folder.delete();
    } catch {
      // In use or already gone: the new files take new names either way.
    }
    folder.create({ intermediates: true, idempotent: true });
  }
  return folder;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg" };

/** Writes `chunks` to a new file and gives its file:// URI. */
export async function keepPicture(chunks: AsyncIterable<Uint8Array>, type: string): Promise<string> {
  const file = new File(pictures(), `${Date.now().toString(36)}-${++count}.${EXT[type.split(";")[0].trim().toLowerCase()] ?? "img"}`);
  file.create({ overwrite: true });
  const handle = file.open(FileMode.WriteOnly);
  try {
    for await (const chunk of chunks) await handle.writeBytes(chunk);
  } catch (e) {
    handle.close();
    try {
      file.delete();
    } catch {
      // Left for the next run to clear.
    }
    throw e;
  }
  handle.close();
  return file.uri;
}
