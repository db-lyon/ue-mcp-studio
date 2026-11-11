/**
 * chat/ReplyMarkdown.tsx: markdown as a reply renders it, shared by the
 * transcript and the file viewer. Each link draws as remarkReplyLinks
 * classified it: an asset link, a token linked once resolved, or a file link.
 */
import type { ReactNode } from "react";
import { Image, Text } from "react-native";
import { localImagePath, projectImageType, projectImageUrl } from "@ue-mcp-studio/shared";
import { Markdown, useTheme, type LinkMark } from "../ui";
import { useDaemonImage } from "../screens/chat/composer/attachments";
import { AssetToken, ExactAssetLink } from "./AssetLink";
import { FileLink } from "./FileLink";
import { breakable } from "./breakable";

export const renderReplyMark = (mark: LinkMark, children: ReactNode, key: number): ReactNode =>
  mark.kind === "exact" ? <ExactAssetLink key={key} path={mark.path} label={mark.label} />
    : mark.kind === "token" ? <AssetToken key={key} token={mark.token} code={mark.code} />
    : <FileLink key={key} path={mark.path} line={mark.line}>{children}</FileLink>;

/** An image in a reply: a project file through Studio (a playtest's capture, a screenshot), a web image as it is; its alt text while it loads. */
function ReplyImage({ src, alt }: { src: string; alt: string }) {
  const t = useTheme();
  const local = localImagePath(src);
  const loaded = useDaemonImage(local ? projectImageUrl(local) : undefined, (local && projectImageType(local)) || "image/png");
  const uri = local ? loaded : /^https?:/i.test(src) ? src : null;
  if (!uri) return <Text style={{ color: t.c.accentHi }} accessibilityRole="image">{alt}</Text>;
  return <Image accessibilityRole="image" accessibilityLabel={alt} source={{ uri }} resizeMode="contain" style={{ width: 280, height: 200, borderRadius: 8, borderWidth: 1, borderColor: t.c.line }} />;
}

export const renderReplyImage = (src: string, alt: string, key: number): ReactNode => <ReplyImage key={key} src={src} alt={alt} />;

export function ReplyMarkdown({ text, page }: { text: string; page?: boolean }) {
  return <Markdown text={text} links renderMark={renderReplyMark} renderCode={breakable} renderImage={renderReplyImage} page={page} />;
}
