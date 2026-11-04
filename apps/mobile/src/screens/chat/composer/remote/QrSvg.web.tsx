/** A pairing code's QR on the web build (the parity page and component tests): the markup itself, as the web client draws it. */
import { createElement } from "react";

export function QrSvg({ xml, size }: { xml: string; size: number }) {
  return createElement("div", {
    "data-testid": "pairing-qr",
    style: { width: size, height: size, display: "block", lineHeight: 0 },
    dangerouslySetInnerHTML: { __html: xml.replace(/<svg\b/, '<svg style="display:block;width:100%;height:100%"') },
  });
}
