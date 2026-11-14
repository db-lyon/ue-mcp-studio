import Markdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { classifyLink, remarkReplyLinks } from "@ue-mcp-studio/client-core";
import { localImagePath } from "@ue-mcp-studio/shared";
import { ReplyImage } from "./ReplyImage";
import { AssetToken, ExactAssetLink } from "./AssetLink";
import { FileLink } from "./FileLink";
import { breakable } from "./breakable";

type Marks = { "data-asset"?: string; "data-asset-path"?: string; "data-asset-label"?: string; "data-file-path"?: string; "data-file-line"?: string };

/**
 * Each link as remarkReplyLinks classified it: web pages open outside Studio,
 * object paths open the asset, project files open in the file viewer. Inline
 * code and bare object paths that name an asset link once resolved.
 */
const REPLY_COMPONENTS: Components = {
  code: ({ node: _node, children, ...props }) => {
    const token = (props as Marks)["data-asset"];
    return token ? <AssetToken token={token} code /> : <code {...props}>{breakable(children)}</code>;
  },
  // Wide tables scroll in a wrapper of their own instead of squeezing their columns.
  table: ({ node: _node, children, ...props }) => <div className="md-table"><table {...props}>{children}</table></div>,
  span: ({ node: _node, children, ...props }) => {
    const m = props as Marks;
    if (m["data-asset-path"]) return <ExactAssetLink path={m["data-asset-path"]} label={m["data-asset-label"] ?? ""} />;
    if (m["data-file-path"]) return <FileLink path={m["data-file-path"]} line={m["data-file-line"] ? Number(m["data-file-line"]) : undefined}>{children}</FileLink>;
    return m["data-asset"] ? <AssetToken token={m["data-asset"]} code={false} /> : <span {...props}>{children}</span>;
  },
  // An image in the project (a playtest's capture, a screenshot) loads through Studio, full size on a click.
  // A tile at its final size from the start: the poster while the file loads, then the file in its place.
  img: ({ node: _node, src, alt }) => {
    const local = localImagePath(typeof src === "string" ? src : null);
    if (!local) return src ? <img className="md-image" src={String(src)} alt={alt ?? ""} loading="lazy" /> : <>{alt}</>;
    return <ReplyImage path={local} alt={alt ?? ""} />;
  },
  // Only web links reach here as links; a reference link to anything else is its text.
  a: ({ node: _node, href, children }) => (classifyLink(href).kind === "web" ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>),
};
const REPLY_PLUGINS = [remarkGfm, remarkBreaks, remarkReplyLinks];

/** The default filter blanks a Windows path ("C:/...") as an unknown protocol; an image on this computer keeps its path. */
const replyUrl: UrlTransform = (url, key) => (key === "src" && localImagePath(url) ? url : defaultUrlTransform(url));

/** Markdown as a reply renders it, without raw HTML; a single line break stays a line break. */
export function ReplyMarkdown({ text }: { text: string }) {
  return <Markdown remarkPlugins={REPLY_PLUGINS} components={REPLY_COMPONENTS} urlTransform={replyUrl}>{text}</Markdown>;
}
