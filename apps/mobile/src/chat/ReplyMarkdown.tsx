/**
 * chat/ReplyMarkdown.tsx: markdown as a reply renders it, shared by the
 * transcript and the file viewer. Each link draws as remarkReplyLinks
 * classified it: an asset link, a token linked once resolved, or a file link.
 */
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import {
  IMAGE_LOAD_FAILED,
  IMAGE_RETRY,
  IMAGE_TILE_MAX_HEIGHT,
  IMAGE_TILE_MAX_WIDTH,
  ReplyImageLoads,
  asksPoster,
  imageKind,
  imageProgress,
  imageProgressLabel,
  imageTileCaption,
  imageTileSize,
  type ReplyImageFetchers,
} from "@ue-mcp-studio/client-core";
import { localImagePath, projectImagePosterUrl, projectImageType, projectImageUrl, type ReplyImageInfo } from "@ue-mcp-studio/shared";
import { Button, Markdown, Spinner, font, useTheme, type LinkMark } from "../ui";
import { useProjectNav } from "../nav";
import { readDaemonPicture } from "./daemon-picture";
import { Picture } from "./Picture";
import { AssetToken, ExactAssetLink } from "./AssetLink";
import { FileLink } from "./FileLink";
import { breakable } from "./breakable";

export const renderReplyMark = (mark: LinkMark, children: ReactNode, key: number): ReactNode =>
  mark.kind === "exact" ? <ExactAssetLink key={key} path={mark.path} label={mark.label} />
    : mark.kind === "token" ? <AssetToken key={key} token={mark.token} code={mark.code} />
    : <FileLink key={key} path={mark.path} line={mark.line}>{children}</FileLink>;

/** What the daemon sent of the reply's images, by path; absent for a reply from an older Studio, and in the file viewer. */
export const ReplyImagesContext = createContext<Record<string, ReplyImageInfo> | undefined>(undefined);

/** Every reply picture's load for the run, by computer and path: a picture shown in two rows, or again after a scroll, is read once. */
export const replyImageLoads = new ReplyImageLoads();

/**
 * A project image in a reply, as a tile at its final size from the start: the
 * poster while the file loads over the relay, with how far it has come, then
 * the file in its place, playing when it is a GIF or an animated WebP. A
 * failed read keeps the tile, with the caption and Retry. A tap on a loaded
 * one opens it full screen.
 */
function ProjectImage({ path, alt, room }: { path: string; alt: string; room: number }) {
  const t = useTheme();
  const { project } = useProjectNav();
  const info = useContext(ReplyImagesContext)?.[path];
  const url = projectImageUrl(path);
  const key = `${project.device.id} ${url}`;
  const type = info?.type ?? projectImageType(path) ?? "image/png";
  const fetchers = useMemo<ReplyImageFetchers>(() => ({
    poster: asksPoster(info) ? () => readDaemonPicture(project, projectImagePosterUrl(path), "image/jpeg") : null,
    full: (progress) => readDaemonPicture(project, url, type, progress),
  }), [project, path, url, type, info?.poster]);
  const total = info?.bytes ?? null;
  const state = useSyncExternalStore((fn) => replyImageLoads.subscribe(key, fn), () => replyImageLoads.get(key));
  useEffect(() => replyImageLoads.load(key, fetchers, total), [key, fetchers, total]);
  // The poster stays under the file until the file has drawn, so the tile never blinks empty.
  const [drawn, setDrawn] = useState<string | null>(null);
  const shown = state.full !== null && drawn === state.full;
  const box = imageTileSize(info, room);
  const phase = state.failed ? "failed" : shown ? "loaded" : state.poster ? "poster" : "waiting";
  const fraction = imageProgress(state.received, state.total ?? total);
  const label = imageProgressLabel(state.received, state.total ?? total) ?? imageTileCaption(info, path);
  const fill = { position: "absolute", left: 0, top: 0, width: box.width, height: box.height } as const;
  return (
    <View
      testID="reply-image-tile"
      accessibilityLabel={phase === "loaded" ? undefined : alt}
      accessibilityRole={phase === "loaded" ? undefined : "image"}
      accessibilityState={{ busy: phase === "poster" || phase === "waiting" }}
      // A test reads the phase off the tile; Android ignores the attribute.
      {...({ dataSet: { phase, legacy: info ? undefined : "true" } } as object)}
      style={{ width: box.width + 2, height: box.height + 2, borderRadius: 8, borderWidth: 1, borderColor: t.c.line, backgroundColor: t.c.panel2, overflow: "hidden" }}
    >
      {state.poster && !shown ? (
        <Image testID="reply-image-poster" source={{ uri: state.poster }} recyclingKey={state.poster} cachePolicy="memory" contentFit="contain" accessibilityIgnoresInvertColors style={fill} />
      ) : null}
      {!state.poster && !shown && !state.failed ? (
        <View style={{ ...fill, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ ...font(t, "mono", 600, 22), color: t.c.dim, opacity: 0.55, letterSpacing: 1.5 }}>{imageKind(type)}</Text>
        </View>
      ) : null}
      {state.full ? (
        <View style={fill}>
          <Picture uri={state.full} alt={alt} maxWidth={box.width} maxHeight={box.height} fixed={box} framed={false} onDrawn={() => setDrawn(state.full)} />
        </View>
      ) : null}
      {!shown && !state.failed ? (
        <View testID="reply-image-status" accessibilityRole="progressbar" style={{ position: "absolute", left: 8, bottom: 8, maxWidth: box.width - 16, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, backgroundColor: "rgba(0,0,0,0.62)" }}>
          <Spinner small style={{ borderColor: "rgba(255,255,255,0.3)", borderTopColor: "#fff" }} />
          <Text numberOfLines={1} style={{ ...font(t, "sans", 500, 12), color: "#fff", flexShrink: 1 }}>{label}</Text>
        </View>
      ) : null}
      {!shown && !state.failed && fraction !== null && fraction > 0 ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3, backgroundColor: "rgba(0,0,0,0.35)" }}>
          <View testID="reply-image-bar" style={{ width: `${Math.round(fraction * 100)}%`, height: 3, backgroundColor: t.c.accent }} />
        </View>
      ) : null}
      {state.failed ? (
        <View style={{ ...fill, alignItems: "center", justifyContent: "center", gap: 8, padding: 12 }}>
          {alt ? <Text numberOfLines={2} style={{ ...font(t, "sans", 400, 13), color: t.c.text, textAlign: "center" }}>{alt}</Text> : null}
          <Text style={{ ...font(t, "sans", 400, 13), color: t.c.dim, textAlign: "center" }}>{IMAGE_LOAD_FAILED}</Text>
          <Button title={IMAGE_RETRY} size="small" onPress={() => replyImageLoads.retry(key, fetchers, total)} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * An image in a reply, on a line of its own as `.md-image` is a block: a project
 * file through Studio (a playtest's capture, a screenshot) as its tile, a web
 * image as it is.
 */
function ReplyImage({ src, alt }: { src: string; alt: string }) {
  const t = useTheme();
  // The window less the transcript's sides until the line has been laid out.
  const window = useWindowDimensions().width;
  const [laid, setWidth] = useState(0);
  const width = laid || Math.max(1, window - 24);
  const local = localImagePath(src);
  const web = !local && /^https?:/i.test(src) ? src : null;
  return (
    // `.md-image`'s 6px margins, and below them the descent of the line the web's inline-block link sits on.
    <View style={{ alignSelf: "stretch", marginTop: 6, marginBottom: 14 }} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
      {local ? (
        <ProjectImage path={local} alt={alt} room={Math.max(1, width - 2)} />
      ) : web ? (
        <Picture uri={web} alt={alt} maxWidth={Math.min(width, IMAGE_TILE_MAX_WIDTH)} maxHeight={IMAGE_TILE_MAX_HEIGHT} />
      ) : (
        <Text style={{ color: t.c.accentHi }} accessibilityRole="image" accessibilityLabel={alt}>{alt}</Text>
      )}
    </View>
  );
}

export const renderReplyImage = (src: string, alt: string, key: number): ReactNode => <ReplyImage key={key} src={src} alt={alt} />;

export function ReplyMarkdown({ text, page }: { text: string; page?: boolean }) {
  return <Markdown text={text} links renderMark={renderReplyMark} renderCode={breakable} renderImage={renderReplyImage} page={page} />;
}
