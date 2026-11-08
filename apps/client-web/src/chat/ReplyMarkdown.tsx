import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { classifyLink, remarkReplyLinks } from "@ue-mcp-studio/client-core";
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
  // Only web links reach here as links; a reference link to anything else is its text.
  a: ({ node: _node, href, children }) => (classifyLink(href).kind === "web" ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>),
};
const REPLY_PLUGINS = [remarkGfm, remarkBreaks, remarkReplyLinks];

/** Markdown as a reply renders it, without raw HTML; a single line break stays a line break. */
export function ReplyMarkdown({ text }: { text: string }) {
  return <Markdown remarkPlugins={REPLY_PLUGINS} components={REPLY_COMPONENTS}>{text}</Markdown>;
}
