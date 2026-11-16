/**
 * expo-video for component tests and the visual QA page: a <video> the
 * browser plays, carrying the source the player was made with.
 */
type Player = { uri: string };

export function useVideoPlayer(source: string | { uri: string }): Player {
  return { uri: typeof source === "string" ? source : source.uri };
}

export function VideoView({ player, accessibilityLabel }: { player: Player; nativeControls?: boolean; contentFit?: string; accessibilityLabel?: string; style?: unknown }) {
  return <video data-testid="expo-video" src={player.uri} controls aria-label={accessibilityLabel} />;
}
