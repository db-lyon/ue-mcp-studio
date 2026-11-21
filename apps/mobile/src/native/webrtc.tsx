/**
 * WebRTC on Android: react-native-webrtc's peer connection, and its RTCView
 * for the live viewport's video. Receive only, so the app asks for no camera
 * or microphone permission (app.json blocks RECORD_AUDIO) and needs no config
 * plugin: autolinking adds the native module. The .web variant stands in for
 * the visual QA page and the component tests.
 */
import { useEffect } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { RTCPeerConnection, RTCView, type MediaStream } from "react-native-webrtc";
import type { PeerFactory } from "@ue-mcp-studio/client-core";

export const peerFactory: PeerFactory = (config) => new RTCPeerConnection(config) as never;

/** The stream's video, scaled to fit; `muted` turns its audio tracks off. */
export function VideoView({ stream, muted, style }: { stream: unknown; muted: boolean; style?: StyleProp<ViewStyle> }) {
  const s = stream as MediaStream;
  useEffect(() => {
    for (const t of s.getAudioTracks()) t.enabled = !muted;
  }, [s, muted]);
  return <RTCView streamURL={s.toURL()} objectFit="contain" style={style} />;
}
