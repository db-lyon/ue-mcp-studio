/** WebRTC on the web build (visual QA, component tests): the browser's peer connection and a <video>. */
import { createElement, useEffect, useRef } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { PeerFactory } from "@ue-mcp-studio/client-core";

export const peerFactory: PeerFactory = (config) => new RTCPeerConnection(config) as never;

export function VideoView({ stream, muted, style }: { stream: unknown; muted: boolean; style?: StyleProp<ViewStyle> }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream as MediaStream;
  }, [stream]);
  return (
    <View style={style}>
      {createElement("video", { ref, autoPlay: true, playsInline: true, muted, style: { width: "100%", height: "100%", objectFit: "contain", background: "#000" } })}
    </View>
  );
}
