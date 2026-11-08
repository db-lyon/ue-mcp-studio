/**
 * chat/ReplyMarkdown.tsx: markdown as a reply renders it, shared by the
 * transcript and the file viewer. Each link draws as remarkReplyLinks
 * classified it: an asset link, a token linked once resolved, or a file link.
 */
import type { ReactNode } from "react";
import { Markdown, type LinkMark } from "../ui";
import { AssetToken, ExactAssetLink } from "./AssetLink";
import { FileLink } from "./FileLink";
import { breakable } from "./breakable";

export const renderReplyMark = (mark: LinkMark, children: ReactNode, key: number): ReactNode =>
  mark.kind === "exact" ? <ExactAssetLink key={key} path={mark.path} label={mark.label} />
    : mark.kind === "token" ? <AssetToken key={key} token={mark.token} code={mark.code} />
    : <FileLink key={key} path={mark.path} line={mark.line}>{children}</FileLink>;

export function ReplyMarkdown({ text, page }: { text: string; page?: boolean }) {
  return <Markdown text={text} links renderMark={renderReplyMark} renderCode={breakable} page={page} />;
}
