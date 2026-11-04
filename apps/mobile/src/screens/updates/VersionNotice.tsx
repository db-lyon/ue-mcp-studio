/**
 * The notices a paired client shows about Studio's version (client-web
 * VersionNotice and Refused, as a paired browser draws them): another project
 * installed a newer Studio, which this project can move to on the computer;
 * and Studio refused by a ue-mcp older than it needs, the whole page, with
 * the note that updates run on the computer. Neither offers a button: both
 * fixes install software on the computer.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { REMOTE_UPDATES, notThere, type StudioVersionNotice } from "@ue-mcp-studio/client-core";
import { refusalInHealth, type StudioRefusal } from "@ue-mcp-studio/shared";
import { Banner, bannerText, font, T, useTheme } from "../../ui";
import { Span, Txt } from "../settings/controls";
import { useSettingsApi } from "../settings/hooks";
import { useProjectNav } from "../../nav";

/** How often the notice is read again: another project can install a version at any time. */
export const NOTICE_POLL_MS = 5 * 60_000;

/** The banner at the top of the page, while the project's event stream is live. */
export function VersionNotice() {
  const api = useSettingsApi();
  const { project } = useProjectNav();
  const [notice, setNotice] = useState<StudioVersionNotice | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (project.live !== "live") return;
    let live = true;
    const read = () => api.versionNotice().then((r) => live && setNotice(r.notice), (e) => !notThere(e) && live && setError((e as Error).message));
    void read();
    const timer = setInterval(read, NOTICE_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, project.live]);
  if (!notice) return null;
  return <VersionNoticeLine notice={notice} error={error} />;
}

export function VersionNoticeLine({ notice, error }: { notice: StudioVersionNotice; error: string | null }) {
  const t = useTheme();
  return (
    <Banner kind="warn" role="status" style={{ marginTop: 6, marginHorizontal: 6, marginBottom: 10 }}>
      <Txt style={{ color: bannerText(t, "warn") }}>
        Studio {notice.installed} was installed by another project. This project uses {notice.current}.{error ? <Span tone="dim"> {error}</Span> : null}
        <Span tone="dim"> {REMOTE_UPDATES}</Span>
      </Txt>
    </Banner>
  );
}

/** Studio's refusal: from health when the daemon checks the floor itself, else Studio's own route; undefined until known. */
export function useRefusal(): StudioRefusal | null | undefined {
  const api = useSettingsApi();
  const [fromHealth, setFromHealth] = useState<StudioRefusal | null | undefined>(undefined);
  const [own, setOwn] = useState<StudioRefusal | null | undefined>(undefined);
  useEffect(() => {
    api.health().then((h) => setFromHealth(refusalInHealth(h as never)), () => setFromHealth(null));
    api.refusal().then((r) => setOwn(r && typeof (r as StudioRefusal).needs === "string" ? (r as StudioRefusal) : null), () => setOwn(null));
  }, [api]);
  if (fromHealth) return fromHealth;
  if (fromHealth === undefined || own === undefined) return undefined;
  return own;
}

/** The whole page when Studio needs a newer ue-mcp: what it needs and has, and where that is fixed. */
export function RefusedScreen({ refusal }: { refusal: StudioRefusal }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 28, paddingHorizontal: 14, gap: 18 }}>
      <T style={[font(t, "sans", 600, 18, 1.35), { color: t.c.text, textAlign: "center", maxWidth: 460 }]}>
        Studio needs ue-mcp {refusal.needs}. You have {refusal.have}.
      </T>
      <Txt tone="muted" style={{ textAlign: "center" }}>
        {REMOTE_UPDATES}
      </Txt>
    </View>
  );
}
