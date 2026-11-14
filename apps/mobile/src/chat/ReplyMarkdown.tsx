/**
 * chat/ReplyMarkdown.tsx: markdown as a reply renders it, shared by the
 * transcript and the file viewer. Each link draws as remarkReplyLinks
 * classified it: an asset link, a token linked once resolved, or a file link.
 */
import { useState, type ReactNode } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { localImagePath, projectImageType, projectImageUrl } from "@ue-mcp-studio/shared";
import { Markdown, useTheme, type LinkMark } from "../ui";
import { useDaemonPicture } from "./daemon-picture";
import { Picture } from "./Picture";
import { AssetToken, ExactAssetLink } from "./AssetLink";
import { FileLink } from "./FileLink";
import { breakable } from "./breakable";

export const renderReplyMark = (mark: LinkMark, children: ReactNode, key: number): ReactNode =>
  mark.kind === "exact" ? <ExactAssetLink key={key} path={mark.path} label={mark.label} />
    : mark.kind === "token" ? <AssetToken key={key} token={mark.token} code={mark.code} />
    : <FileLink key={key} path={mark.path} line={mark.line}>{children}</FileLink>;

/** `.md-image`: at most 640 wide and 480 tall, within the message. */
const IMAGE_MAX_WIDTH = 640;
const IMAGE_MAX_HEIGHT = 480;

/**
 * An image in a reply, on a line of its own as `.md-image` is a block: a project
 * file through Studio (a playtest's capture, a screenshot), a web image as it is.
 * GIFs and animated WebPs play. Its alt text while it loads, and after a failed read.
 */
function ReplyImage({ src, alt }: { src: string; alt: string }) {
  const t = useTheme();
  // The window less the transcript's sides until the line has been laid out.
  const window = useWindowDimensions().width;
  const [laid, setWidth] = useState(0);
  const width = laid || Math.max(1, window - 24);
  const local = localImagePath(src);
  const loaded = useDaemonPicture(local ? projectImageUrl(local) : undefined, (local && projectImageType(local)) || "image/png");
  const uri = local ? (loaded === "failed" ? null : loaded) : /^https?:/i.test(src) ? src : null;
  return (
    // `.md-image`'s 6px margins, and below them the descent of the line the web's inline-block link sits on.
    <View style={{ alignSelf: "stretch", marginTop: 6, marginBottom: 14 }} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
      {uri ? (
        <Picture uri={uri} alt={alt} maxWidth={Math.min(width, IMAGE_MAX_WIDTH)} maxHeight={IMAGE_MAX_HEIGHT} />
      ) : (
        <Text style={{ color: loaded === null && local ? t.c.dim : t.c.accentHi }} accessibilityRole="image" accessibilityLabel={alt}>{alt}</Text>
      )}
    </View>
  );
}

export const renderReplyImage = (src: string, alt: string, key: number): ReactNode => <ReplyImage key={key} src={src} alt={alt} />;

export function ReplyMarkdown({ text, page }: { text: string; page?: boolean }) {
  return <Markdown text={text} links renderMark={renderReplyMark} renderCode={breakable} renderImage={renderReplyImage} page={page} />;
}
