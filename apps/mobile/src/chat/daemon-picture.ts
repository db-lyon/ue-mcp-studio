/**
 * A picture the computer serves (a reply's project image, a sent image, an
 * image a tool showed the model), read through the project's transport into a
 * file an Image can draw, animated when it is a GIF or an animated WebP. One read
 * per picture for the run, however many rows draw it; a read that failed is
 * tried again the next time the picture is drawn.
 */
import { useEffect, useState } from "react";
import { useProjectNav } from "../nav";
import { keepPicture } from "../native/picture-file";

/** The picture's URI, null while it loads, "failed" when it could not be read. */
export type PictureState = string | null | "failed";

const reading = new Map<string, Promise<string>>();
const kept = new Map<string, string>();

async function read(project: ReturnType<typeof useProjectNav>["project"], path: string, type: string): Promise<string> {
  const r = await project.transport("GET", path, { headers: { accept: "image/*" } });
  if (r.status >= 400 || !r.body) {
    if (r.body) for await (const _ of r.body) void _;
    throw new Error(`The computer answered ${r.status}.`);
  }
  return keepPicture(r.body, r.headers["content-type"] || type);
}

export function useDaemonPicture(path: string | undefined, type = "image/png"): PictureState {
  const { project } = useProjectNav();
  const id = path ? `${project.device.id} ${path}` : "";
  const [state, setState] = useState<{ id: string; value: PictureState }>(() => ({ id, value: kept.get(id) ?? null }));
  useEffect(() => {
    if (!path) return;
    const hit = kept.get(id);
    if (hit) return setState({ id, value: hit });
    let alive = true;
    let pending = reading.get(id);
    if (!pending) {
      pending = read(project, path, type);
      reading.set(id, pending);
      pending.then((uri) => kept.set(id, uri), () => undefined).finally(() => reading.delete(id));
    }
    pending.then((uri) => alive && setState({ id, value: uri }), () => alive && setState({ id, value: "failed" }));
    return () => {
      alive = false;
    };
  }, [id, path, project, type]);
  if (!path) return null;
  return state.id === id ? state.value : kept.get(id) ?? null;
}
