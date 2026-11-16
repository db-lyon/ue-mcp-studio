/**
 * The web client's SentVideo (chat/Transcript.tsx): a video a message carried.
 * It plays when it fits the account's limit, read through the relay into a
 * file the player opens; otherwise the offer: Compress and play, Check again
 * when the computer has no encoder yet, and the upgrade where a plan plays it.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { VIDEO_COMPRESSING_LABEL, VIDEO_COMPRESS_LABEL, VIDEO_RECHECK_LABEL, attachmentUrl, forgetVideoLimits, formatBytes, videoLimitsOnce, videoTile } from "@ue-mcp-studio/client-core";
import type { Attachment, VideoLimits } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../nav";
import { Banner, Button, T, useTheme } from "../ui";
import { readDaemonPicture } from "./daemon-picture";
import { UpgradeAction } from "../screens/chat/composer/remote/Upgrade";

/** A video file on the phone, played inline with the system's controls. */
function Player({ uri, label }: { uri: string; label: string }) {
  const player = useVideoPlayer(uri);
  return <VideoView player={player} nativeControls contentFit="contain" accessibilityLabel={label} style={{ width: 260, height: 160, backgroundColor: "#000", borderRadius: 6 }} />;
}

/** The attachment `play` read into a file, then played. */
function Loaded({ sessionId, play, label }: { sessionId: string; play: Attachment; label: string }) {
  const { project } = useProjectNav();
  const [uri, setUri] = useState<string | null | "failed">(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let alive = true;
    setUri(null);
    readDaemonPicture(project, attachmentUrl(sessionId, play.id), play.type).then((u) => alive && setUri(u), () => alive && setUri("failed"));
    return () => {
      alive = false;
    };
  }, [project, sessionId, play.id, play.type, tries]);
  if (uri === "failed") {
    return (
      <View style={{ gap: 6 }}>
        <T>{label}: the video could not be read.</T>
        <Button size="small" title="Try again" onPress={() => setTries((n) => n + 1)} />
      </View>
    );
  }
  if (!uri) return <T>{label}</T>;
  return <Player uri={uri} label={label} />;
}

export function SentVideo({ file, sessionId }: { file: Attachment; sessionId: string }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [limits, setLimits] = useState<VideoLimits | null>(null);
  const [copy, setCopy] = useState<Attachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let alive = true;
    void videoLimitsOnce(() => api.videoLimits()).then((l) => alive && setLimits(l));
    return () => {
      alive = false;
    };
  }, [api, asked]);
  const label = `${file.name}, ${formatBytes(file.size)}`;
  if (!limits) return <T>{label}</T>;
  const tile = videoTile(file, limits, copy);
  if (tile.play) return <Loaded sessionId={sessionId} play={tile.play} label={label} />;
  const compress = async () => {
    setBusy(true);
    setError(null);
    try {
      setCopy(await api.compressVideo(sessionId, file.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      forgetVideoLimits();
    } finally {
      setBusy(false);
    }
  };
  const recheck = () => {
    forgetVideoLimits();
    setAsked((n) => n + 1);
  };
  return (
    <View style={{ gap: 6, maxWidth: 360, paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: t.c.accentLine, borderRadius: 6 }}>
      <T>{label}</T>
      <T style={{ color: t.c.dim }}>{tile.offer}</T>
      {error ? <Banner kind="bad">{error}</Banner> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {tile.compress ? <Button size="small" variant="primary" disabled={busy} title={busy ? VIDEO_COMPRESSING_LABEL : VIDEO_COMPRESS_LABEL} onPress={() => void compress()} /> : null}
        {tile.recheck ? <Button size="small" title={VIDEO_RECHECK_LABEL} onPress={recheck} /> : null}
      </View>
      {tile.upgrade ? <UpgradeAction /> : null}
    </View>
  );
}
