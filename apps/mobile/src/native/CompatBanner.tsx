/**
 * Under the top bar while the paired computer runs a Studio older than this
 * app needs: what to update, in the web client's warn banner.
 */
import { useEffect, useState } from "react";
import { useProjectNav } from "../nav";
import { Banner } from "../ui";
import { studioTooOld, versionsOf } from "./compat";

export function CompatBanner() {
  const { api, project } = useProjectNav();
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (project.live !== "live") return;
    let live = true;
    api.health().then(
      (h) => live && setMessage(studioTooOld(versionsOf(h).studio)),
      () => undefined,
    );
    return () => void (live = false);
  }, [api, project.live]);
  if (!message) return null;
  return (
    <Banner kind="warn" role="status" style={{ marginHorizontal: 6, marginTop: 6, marginBottom: 0 }}>
      {message}
    </Banner>
  );
}
