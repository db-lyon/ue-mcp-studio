/** A pairing code's QR, from the svg markup the agent made: react-native-svg's SvgXml. */
import { SvgXml } from "react-native-svg";

export function QrSvg({ xml, size }: { xml: string; size: number }) {
  return <SvgXml xml={xml} width={size} height={size} />;
}
